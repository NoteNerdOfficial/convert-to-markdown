# Document types and templates

Status: built — phases 0–7 done · planned 2026-10-06, completed 2026-10-06

This started as a plan and is now the record of what was built and why. Where
the build departed from the plan, the section says so and gives the reason.
What's still open is at the end.

## Goal

Let a user say what a document *is* ("this is an invoice") and get a note
shaped for that kind of document:

- the facts that matter (vendor, number, dates, total) as frontmatter
  properties that Dataview/Bases can query,
- tables that stay tables, including on scanned and photographed documents,
- the original file embedded in the note,
- all of it laid out by a template the user controls.

"General" conversion stays the default, and its output changed only where
shared improvements made it better: tables, the embed-original setting,
form fields, and frontmatter quoting.

## Principles

- **Deterministic.** No LLM. A type is a set of label rules and a layout,
  not a model that "understands" the document. The same file and settings
  always produce the same note.
- **Coverage is visible.** Every field a type expects but couldn't find is
  named in `missing_fields`. Every value that came from OCR or a guess is
  marked as such. Arithmetic that doesn't add up is reported with both
  numbers. Nothing goes missing silently.
- **Explicit over inferred.** The user picks the type. Nothing guesses it.
- **Bail out instead of inventing structure.** A table that doesn't line up
  convincingly stays as text. A missed table reads as before; an invented one
  scrambles text that was fine.

## How it works

```
 text PDF ───────▶ pdf.js runs ──┐                    ┌──▶ General note (paragraphs + tables)
                                 ├─▶ positioned rows ─┤
 image / scanned ─▶ Tesseract ───┘   + tables          └──▶ Document type ──▶ Template ──▶ typed note
 PDF page           words, joined    (ExtractResult        (fields, checks,    (user note or
                    into runs         .layout)              provenance)         built-in)
```

### Layout (`src/layout/`)

`LayoutRow` is a line of positioned text, `y` growing down the page;
`LayoutItem` is a run on it with `x`, `width` and `size`. `LayoutPage`
(`page.ts`) holds a page's rows, the tables found among them, and whether
the text was extracted (`text`) or recognised (`ocr`). Extractors with
positions (PDF, images) return pages as `ExtractResult.layout`.

*Changed from the plan:* the planned `Word`/`Line`/`Page` types with boxes
and a separate label/value layer were more than was needed. Rows of runs
carry everything the table detector and the field finder use.

### Tables (`src/layout/tables.ts`)

A column boundary is a strip of the page that **no row of a block puts ink
on**. That's what lets the detector find a browser's tight invoice columns,
set a third of an em apart (narrower than a word space), while leaving prose
alone, since word gaps fall somewhere different on every line.

- **Blocks:** rows close enough to be one table. Wide gaps continue a block
  when the row pitch repeats (LibreOffice sets rows nearly three lines apart)
  or when a header steps down to its first row. A heading set much larger
  than its neighbours ends a block. A block where nothing holds up is split
  at its widest gap and searched again, and a block can hold several tables.
- **Edges:** a table starts with a header labelling at least half the
  columns and ends with a row of at least two cells. One-row columns are
  folded into a neighbour unless they're a row label at the table's edge
  ("Total").
- **Rows:** baselines fold into one row when they're a wrapped line or cells
  centred against a tall one. What "close enough" means is learned per table
  from its two kinds of gap (leading inside a cell, padding between rows),
  with a fixed limit when it has only one.
- **Not tables:** two columns are a table only when the right one is
  numbers. Columns of running text are rejected, and so are monospaced
  sentences split at false gutters (columns mostly starting lowercase).
- Number columns are right-aligned.

*Changed from the plan:* the plan split lines at gaps wider than 1.5 word
spaces and matched cell edges to anchors. Real PDFs broke that immediately,
with columns closer than a word space, so the strip-based method replaced it.
The header is always the first row, following the repo's existing `table()`
convention, rather than being detected.

### Tables in scans and photos (`src/recognize.ts`)

- **Words joined into runs:** OCR words closer than one line height are
  joined into runs before detection, so an OCR'd row looks like a PDF's.
- **Tilt is straightened, not refused:** the page's median baseline slope is
  taken out first. Tables are skipped, with a note, only when baselines
  disagree with each other (a photo at an angle, curled paper).
- **A second OCR pass when a page hints at a table:** Tesseract's layout
  analysis cuts a narrow column of figures into a block of its own and
  misreads it ("4.75" came back as ".75"), so when the ordinary reading has
  three or more rows with separate runs, the page is read again as one block
  of lines. Tables come from that pass; everything else, including the rows
  fields are read from, comes from the ordinary one.
- **Doubtful tables are flagged:** under 80% confidence; and words the
  ordinary reading found in a table's area but missing from the table are
  named.

*Changed from the plan:* the plan bailed out on tilt. Straightening worked
up to the 4° tested, so only warped pages are skipped. The second pass
wasn't planned; it was the fix for Tesseract's own layout step.

### Fields (`src/types/fields.ts`, `values.ts`)

A `FieldSpec` is a key, a display name, the labels documents print for it,
a kind (`text`, `id`, `account`, `money`, `date`, `block`), whether it's
core (named in `missing_fields` when absent), and which occurrence wins a
tie. Values are found:

- **inline:** before any colon on a line (`Account ending 4821 · Statement
  period: …` yields the period), or a label's words followed by the value
  (`Amount due $1,469.00`);
- **beside:** the next run on the line, or centred against a label that
  wraps onto two lines;
- **below:** the line under the label, or every line until a gap for a
  `block` field like an address.

Labels are matched whole after normalising (case, trailing punctuation,
`(13%)`, the ways of writing "No."), on either half of a bilingual label.
The most specific label wins, then the most direct layout, then position. A
`sum` field (tax) adds equally good matches on different lines.

`values.ts` parses money (`$1,469.00 CAD`, `−$11.30`, `(45.00)`,
`1.234,56 €`; percentages are never amounts) and dates (`05 October 2026`,
`Oct. 6, 2026`, ISO, `06/10/2026`). An all-number date is decided by the
**Date order** setting and listed in `ambiguous_fields` whenever it could be
read either way.

### Document types (`src/types/`)

`DocumentType` has an id, a name, a built-in template, its fields, and
`read(pages, dateOrder, extraLabels)`, which returns field values, blocks,
the four provenance lists, and warnings. `shared.ts` holds the guesses both
types use: the most prominent line at the top (skipping tables and
title words), and the first date.

| Type | Properties | Block | Checks |
|---|---|---|---|
| **Invoice / receipt** (`invoice.ts`) | vendor, invoice_number, invoice_date, due_date, subtotal, tax, total, currency (plus po_number, bill_to, shipping, discount for templates) | `line_items` | items add up to the subtotal (or total); subtotal + tax + shipping − discount = total |
| **Statement** (`statement.ts`) | institution, account_last4, period_start, period_end, opening_balance, closing_balance, currency | `transactions` | each row against the running balance; opening + transactions = closing; both sign conventions tried, the statement's own balances decide; one wrong figure reported once |

A statement's transactions are joined across pages by their repeated header.
The invoice's line-items table is the one whose header reads like one, or,
on a till receipt with no header, the largest table that isn't mostly
totals. Rows from the first subtotal/total on aren't summed.

### Templates (`src/template.ts`, `src/types/compose.ts`)

A template is an ordinary note with `{{field}}` placeholders, plus
`{{content}}` (the whole conversion), `{{original}}` (the embed),
`{{line_items}}`/`{{transactions}}`, and `{{title}}`/`{{date}}`/`{{time}}`
as in core Templates. Date fields take a format: `{{due_date:DD MMM YYYY}}`.

- **Values are written YAML-safe:** a value is quoted where YAML would read
  it as something else (`0042`, `yes`). Numbers are written bare, and ISO
  dates stay dates.
- **A missing value leaves the property empty,** never deleted.
- **Unknown placeholders stay as typed** and are named in the notes.
  Templater code is left untouched.
- **Coverage keys are always written:** `source`, `source_format`,
  `converted`, coverage counts, and the four provenance lists. They go where
  the template places them, otherwise appended.
- **A deleted or unclosed template note** falls back to the built-in
  template, with a note saying why.

*Changed from the plan:* the built-in templates leave out a separate
`{{line_items}}` section, because `{{content}}` already contains the table
and it showed twice. The engine is ~370 lines rather than ~150, since each
place a placeholder can sit in YAML needs its own handling.

### Settings and UI

- **File menu:** "Convert to Markdown as invoice / receipt" and "… as
  statement" on PDFs and images.
- **Commands:** "Convert a file as …" for each type.
- **Embed the original PDF:** off / above / below (General conversions).
  Typed conversions always provide `{{original}}`.
- **Date order:** from system language / day first / month first.
- **Per type, under its own heading at the end of settings:** **Template
  note** (with a note picker and **Create from built-in**) and **Extra labels
  to read fields by**, per field, comma-separated.

*Changed from the plan:* one menu item per type rather than a submenu, since
two items read fine and avoid an undocumented API.

### Fillable PDF forms (`src/extractors/pdfForms.ts`)

pdf.js `getFieldObjects()` gives a fillable form's real values. They go
before the page text as a Field | Value table, with `form_fields_filled` in
the frontmatter; empty fields, unticked boxes and signature fields are named
in the notes. Field names aren't made properties: they aren't safe keys.

## Phases

Each phase shipped on its own and left General output unchanged or better.

| # | Phase | Status | Notes |
|---|---|---|---|
| 0 | **Embed original** setting | Done | PDF only: images embed themselves, and Obsidian can't show other formats inline. |
| 1 | **Layout model** | Done | Positioned rows of runs from pdf.js and OCR alike; `ExtractResult.layout`. |
| 2 | **Tables in text PDFs** | Done | Strip-based column detection. |
| 3 | **Tables in scans and photos** | Done | Word runs, tilt straightening, second OCR pass, confidence and unplaced-word notes. |
| 4 | **Fillable form fields** | Done | |
| 5 | **Type framework + invoice/receipt** | Done | Field finder, parsing, checks, provenance, menu/command, Date order. |
| 6 | **Template notes + extra labels** | Done | Settings per type; fallback to built-in. |
| 7 | **Statement type** | Done | Proved the framework general: only shared helpers and two field-matching improvements were needed. |

Fixes made along the way: frontmatter values that YAML would retype are
quoted (`yamlValue`); form fields are ordered line by line.

## Verification

There's no test suite, by design of the repo so far. Verification was:

- **The harness:** `tools/convert.mjs`, with `TYPE`, `TEMPLATE`, `LABELS`
  and `DATE_ORDER` environment variables for typed conversions.
- **A synthetic corpus,** kept outside the repo:
  - 24 text PDFs from Chrome and LibreOffice: invoices, receipts,
    statements, a timetable and a table of contents, plus non-tables
    (prose, two-column and monospaced text, newsletters, a fill-in form);
  - 22 images and scans, clean, tilted 1.5° and 4°, noisy JPEG, and scanned
    PDFs;
  - a fillable form, a card statement, and a two-page statement with one
    deliberately wrong balance;
  - one real invoice supplied by the user.
- **Byte comparison before and after every change:** General output was
  compared for all of them; typed output was compared across later phases.
- **The Demo vault, before each commit:** conversions, the menu, settings
  and properties were checked in Obsidian.

*Changed from the plan:* no committed `samples/` corpus or snapshot script.
The synthetic files stayed in the session's scratch space, and real
documents never enter the repo.

## Decisions

1. **Types for docx/html: v2.** Those formats already have real tables;
   they need a layout adapter. v1 offers types for PDFs and images.
2. **Money fields are plain numbers** with `currency` alongside, so Bases
   can sum and sort them. `$` is kept as printed, since it names a dozen
   currencies.
3. **Statements keep only the last four digits** of the account number as a
   property. The full number stays in the converted text, as printed.

## Open

- **Tax read from a tax-summary table** (Amazon prints it only there). This
  needs the sum check to recognise a subtotal that already includes tax,
  or it would raise a false alarm.
- **Address blocks set side by side** (Bill to | Ship to | Sold by) read
  out of order in the General text.
- **Tables:** cells merged across columns; scanned columns closer than a
  stretched word space.
- **Later:** user-defined fields; a default type per folder; types for
  docx/odt/html (v2); further types (paper, contract, transcript).
