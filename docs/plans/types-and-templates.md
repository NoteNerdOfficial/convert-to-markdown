# Plan: document types and templates

Status: proposal · 2026-10-06

## Goal

Let a user say what a document *is* ("this is an invoice") and get a note
shaped for that kind of document:

- the facts that matter (vendor, number, dates, total) as frontmatter
  properties that Dataview/Bases can query,
- tables that stay tables, including on scanned and photographed documents,
- the original file embedded in the note,
- all of it laid out by a template the user controls.

"General" stays the default and its output doesn't change except where shared
improvements (tables, embed-original) make it better.

## Principles carried over

- **Deterministic.** No LLM. A type is a set of label rules and a layout,
  not a model that "understands" the document. The same file and settings
  always produce the same note.
- **Coverage is visible.** Every field a type expects but couldn't find is
  named in `missing_fields`. Every value that came from OCR or a guess is
  marked as such. Arithmetic that doesn't add up is reported.
  Nothing goes missing silently.
- **Explicit over inferred.** The user picks the type. Nothing guesses it.
- **Bail out instead of inventing structure.** A table that doesn't line up
  convincingly stays as text, the way column detection in `pdf.ts` already
  refuses doubtful columns.

## Architecture

```
                 ┌──────────────┐     ┌───────────────┐
 text PDF ──────▶│ pdf.js glyphs│──┐  │               │
                 └──────────────┘  ├─▶│ Layout model  │──▶ General render (today's output + tables)
 image / scanned ┌──────────────┐  │  │ words, lines, │
 PDF page ──────▶│ Tesseract    │──┘  │ tables, k/v   │──▶ Type profile ──▶ Template ──▶ note
                 │ word boxes   │     └───────────────┘     (fields,        (user note
                 └──────────────┘                            checks)         or default)
```

### 1. Layout model (`src/layout/`)

A format-neutral description of a page:

```ts
interface Word   { text: string; box: Box; size: number; confidence?: number } // confidence only from OCR
interface Line   { words: Word[]; box: Box }
interface Page   { lines: Line[]; tables: Table[]; pairs: LabelValue[]; source: "text" | "ocr" }
interface Table  { rows: Cell[][]; header: boolean; numericColumns: number[]; box: Box }
interface LabelValue { label: string; value: string; box: Box; layout: "inline" | "beside" | "below" }
```

- **pdf.ts** already has `PositionedItem`s and rows; it gains an adapter
  that turns them into `Word`s and `Line`s. Existing paragraph, heading and
  column logic is unchanged.
- **recognize.ts** keeps the word boxes it currently discards
  (`line.words[].bbox`, `confidence`) and returns `Line`s alongside
  `paragraphs`. `buildParagraphs` stays as it is.
- `ExtractResult` gains an optional `layout?: Page[]`. Only extractors that
  have geometry (pdf, image) fill it in. Types work from `layout`, so they
  don't depend on the file format.

### 2. Table detection (`src/layout/tables.ts`), shared by PDF and OCR

Works on lines of words, using gaps between words, not drawn rules:

1. Split each line into **cells** wherever the gap between neighbouring
   words is more than ~1.5× the line's typical space width.
2. Find **runs of consecutive lines** with two or more cells whose edges line
   up on shared column anchors. Text columns align on their left edge,
   number columns on their right edge (that's how invoices set amounts).
3. Accept a run as a table only if:
   - it has ≥ 3 rows, **and** ≥ 3 columns, **or** exactly 2 columns where
     the right one is numeric (receipt lines like `Coffee ……… 4.50`),
   - and ≥ 80% of its cells sit on an anchor.

   Otherwise the lines are left as text.
4. **Header:** the first row, if it's all non-numeric and the rows below it
   aren't.
5. **Wrapped cells:** a row with only the first column filled, directly
   under a full row, continues that row's description.
6. Render as a Markdown table, with numeric columns right-aligned (`---:`).

**OCR-specific:**

- Word boxes from a photo drift more than glyph positions, so the anchor
  tolerance scales with line height rather than being a fixed point value.
- A table whose words average below the OCR confidence threshold is
  rendered, but listed in conversion notes as "table on page N read by OCR,
  check against the original".
- **Tilt check:** if a line's baseline drifts more than about half a line
  height across the page, the photo is too skewed for column anchors.
  Detection bails out for that page and the conversion notes say why.
  Mild skew is fine (Tesseract deskews internally). Perspective-distorted
  phone photos are out of scope for v1.

Out of scope for v1: tables defined only by drawn ruling lines with ragged
text, merged/spanning header cells, and nested tables.

### 3. Label/value detection (`src/layout/pairs.ts`)

Finds the three ways a document pairs a label with a value:

| Layout | Example |
|---|---|
| inline | `Invoice #: 1042` |
| beside | `Due date` ……… `1 Nov 2026` (same baseline, big gap) |
| below | `Invoice date` stacked over `6 Oct 2026` (same left edge, next line) |

Every pair is collected. Types then pick the ones they want. Nothing is
interpreted at this stage.

### 4. Document types (`src/types/`)

```ts
interface DocumentType {
  id: string;                 // "invoice"
  name: string;               // "Invoice / receipt"
  fields: FieldSpec[];
  tables?: TableSpec[];       // e.g. line_items: the table whose header matches description/qty/amount
  checks?: Check[];           // arithmetic that must hold
  defaultTemplate: string;    // built-in template text
}

interface FieldSpec {
  key: string;                // "total"
  labels: string[];           // ["total", "amount due", "balance due", "grand total"]
  kind: "text" | "money" | "date" | "number" | "id";
  strategy?: "pair" | "top-prominent";   // vendor uses top-prominent
}
```

Fields are matched case-insensitively against `pairs` labels after trimming
punctuation. User-added labels from settings (see §6) are merged in.

**Normalization:**
- `money` becomes a number, plus `currency` taken from a symbol or ISO code
  if one is present.
- `date` becomes ISO `YYYY-MM-DD`. An ambiguous date like `03/04/2026` is
  decided by a "Date order" setting (DMY / MDY, defaulting from the system
  locale). If even that can't decide, the raw text is kept and the field is
  named in `ambiguous_fields`.

**Provenance in frontmatter:**
- `missing_fields: [due_date, po_number]`
- `ocr_fields: [total, invoice_date]`: values that came from OCR text
- `guessed_fields: [vendor]`: values that came from a fallback strategy,
  not a label

**Checks (invoice):**
- line-item amounts sum to the subtotal
- subtotal + tax = total

A failed check is named in conversion notes with both numbers. This is the
best defence against OCR misreads, which usually show up as a digit error
that breaks the arithmetic.

**Types in v1:**

| Type | Fields | Table |
|---|---|---|
| **Invoice / receipt** | vendor, invoice_number, invoice_date, due_date, po_number, bill_to, subtotal, tax, total, currency | line_items |
| **Statement** (bank/card), phase 7 | institution, account (last 4 only), period_start, period_end, opening_balance, closing_balance | transactions |

Later candidates: academic paper, contract, meeting transcript, book
(chapter split), slide deck. Each is just another `DocumentType` with its
own fields and template, so none of them needs new architecture.

### 5. Templates

A template is an ordinary note in the vault, chosen per type in settings.
Each type ships with a built-in default that's used when none is set.

```markdown
---
type: invoice
vendor: {{vendor}}
amount: {{total}}
due: {{due_date}}
status: unpaid
tags: [finance, invoices]
---
{{original}}

## Line items
{{line_items}}

{{content}}
```

**Placeholders:**
- every field key in the type, e.g. `{{total}}`
- every table key in the type, e.g. `{{line_items}}`
- `{{content}}`: the full General conversion
- `{{original}}`: embed of the source file
- `{{source}}`: link to the source file
- `{{title}}`, `{{date}}`, `{{time}}`: same meaning as Obsidian core
  Templates, so existing habits carry over
- date fields accept a format: `{{due_date:DD MMM YYYY}}`

**Rules:**
- **Inside frontmatter**, a substituted value is written YAML-safe via the
  existing `yamlValue`. Users write `vendor: {{vendor}}` without worrying
  about colons or quotes in the value.
- **Missing value:** the property is left empty (`due:`), never deleted.
  Queries still see the key, and the field is named in `missing_fields`.
- **Unknown placeholder** (`{{totl}}`): left as-is in the note and named in
  conversion notes.
- **Coverage keys are always written:** `source`, `source_format`,
  `converted`, the extractor's coverage counts, `missing_fields`,
  `ocr_fields`, `guessed_fields`, `ambiguous_fields`. If the template
  doesn't place them, they're appended to its frontmatter. A template can
  move them but can't remove them.
- **Templater syntax** (`<% %>`) is left untouched and never executed.
  Users who want it can run Templater on the result.
- **Missing or unparseable template note:** the conversion uses the
  built-in default and says so in conversion notes. It doesn't fail.

The template engine is about 150 lines: placeholder substitution,
frontmatter-aware quoting, and the coverage-key merge. It is not a logic or
loop language.

### 6. Settings

**General:**
- *Embed original file* (off by default, so existing output doesn't change):
  above or below the converted text. In typed conversions, `{{original}}`
  decides where it goes.
- *Date order*: DMY / MDY / from system.

**Per type** (one collapsible section each):
- *Template note*: file suggester, empty = built-in default. Plus a
  "Create from default" button that writes the built-in template into the
  vault as a starting point.
- *Extra labels*, per field: comma-separated, e.g.
  Total → `Amount payable, Total TTC`.

**Later, not v1:**
- user-defined fields ("value next to `PO Number` → `{{po_number}}`")
- folder → default-type mapping (everything converted from `Invoices/`
  is an invoice)

### 7. UI

- **File menu:** keep "Convert to Markdown" (General), and add a
  "Convert to Markdown as…" submenu listing the types.
- **Command palette:** "Convert a file as…", which picks the file, then
  the type.
- Types are offered only for formats that have a layout (pdf, images) in v1.
  docx, odt and html are planned for v2 (see Decisions).

## Fillable PDF forms

Separate from types, and cheap: pdf.js `getFieldObjects()` returns a fillable
form's actual field names and values. These go into frontmatter (General)
and a key/value table in the body. This is exact, not heuristic. A form with
fields but no values is named as unfilled.

## Phases

Each phase ships on its own and leaves General output either unchanged or
strictly better.

| # | Phase | Notes |
|---|---|---|
| 0 | **Embed original** setting | Independent; smallest change. |
| 1 | **Layout model** + OCR word boxes kept | Refactor only. Harness output on every sample must be byte-identical before/after. |
| 2 | **Table detection on text PDFs** | General output gains tables. |
| 3 | **Table detection on OCR** (images + scanned PDF pages) | Confidence reporting and the tilt bail-out. |
| 4 | **Fillable form fields** | |
| 5 | **Type framework + Invoice/receipt** with built-in template | Pairs, fields, normalization, checks, provenance keys, the "as…" UI. |
| 6 | **Template notes + extra labels** | Settings UI, placeholder engine, coverage-key merge. |
| 7 | **Statement** type | First reuse of the framework, which tests whether it's general. |

## Verification

There's no test suite today. The harness (`tools/convert.mjs`) is the
tool, so:

- **Harness flags:** `--type <id>` and `--template <file>`, so typed
  conversions run outside Obsidian.
- **Golden corpus** under `samples/invoices/`, made of *synthetic*
  documents only (no real invoices committed):
  - text PDFs from several generators: Word export, Google Docs,
    an HTML-to-PDF billing-style layout, a LibreOffice export
  - one fillable form
  - a 300-dpi scan, a straight phone photo, a mildly tilted photo, and a
    long thermal receipt
- **Snapshot script:** converts the corpus and diffs against committed
  expected `.md`. Phase 1 must produce zero diff. Each later phase
  reviews its diff by hand before updating the snapshots.
- **Per document, check:**
  - the line-item table is correct
  - every expected field is either right or named as missing (**never
    wrong-and-unflagged**)
  - checks pass, or fail with the right numbers
- **In Obsidian** (obsidian-verify): the embedded PDF renders, properties
  appear in the Properties view, and a Bases view over converted invoices
  sorts by `total` and `due`.

## Decisions

1. **Types for docx/html invoices: planned for v2.** Those formats already
   have real tables, so only the label/value step would be new. They get a
   layout adapter in v2. v1 offers types for pdf and images only.
2. **Money fields are plain numbers** (`total: 1240.5`, with
   `currency: EUR` alongside), so Bases can sum and sort them.
3. **Statement account numbers keep only the last four digits.** A note
   vault is a poor place for full account numbers.
