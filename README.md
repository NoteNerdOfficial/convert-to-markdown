# Doc to Markdown

Converts PDF, Word, PowerPoint and Excel files in your vault into Markdown notes.

No AI, no API key, no network call, no external binary. Each format is parsed
directly from its own structure, so the same file always produces the same
note.

## Why not markitdown

`markitdown` is one abstraction over every format, which means it makes
one-size-fits-all decisions about what structure means — and those decisions
are where the mess comes from. Here each format gets its own extractor, using
the structure the format already records:

| Format | What it reads | What that buys |
| --- | --- | --- |
| `.docx` | `word/document.xml` paragraphs and `numbering.xml` | Real heading levels from Word's own styles; ordered vs. unordered lists; tables; hyperlinks; bold/italic |
| `.pptx` | Slide parts in `p:sldIdLst` order | One section per slide in *presentation* order, title placeholders as headings, speaker notes, slide tables |
| `.xlsx` | Worksheets, `sharedStrings.xml`, `styles.xml` | Dates instead of serial numbers, `27.38` instead of `27.383982300884924`, hidden helper sheets skipped |
| `.pdf` | The text layer, via pdf.js | Headings from font size, paragraphs rejoined across line breaks, de-hyphenation, running headers/footers dropped |

Macro-enabled variants (`.docm`, `.pptm`, `.xlsm`) are the same parts plus a
VBA blob, and convert identically.

## Usage

- Right-click a supported file in the file explorer → **Convert to Markdown**
- Or run **Doc to Markdown: Convert a file to Markdown** from the command palette

The note is written next to the original (configurable), never overwriting an
existing note. Anything the converter dropped — images, hidden sheets, pages
with no text layer — is listed in a collapsed callout at the end.

## Known limits

- **Scanned PDFs produce nothing.** A PDF that is only page images has no text
  layer to read, and extracting one needs OCR, which this plugin does not do.
  That case is reported as an error rather than silently written as an empty
  note.
- **Images are not extracted**, from any format. Text only.
- **Excel formulas** export as their last-calculated value — the value Excel
  itself stored in the file.
- **Charts and embedded objects** in decks are skipped and counted.
- Letter-spaced PDF headings can pick up stray spaces (`THI S BOOK`); the gap
  between tracked glyphs is genuinely wider than an unspaced word break.

## Development

```sh
npm install
npm run dev     # watch build into main.js
npm run build   # type-check + production bundle
```

`tools/convert.mjs` runs the extractors outside Obsidian, so output can be
checked against real files without reloading a vault:

```sh
OUT_DIR=/tmp/out node tools/convert.mjs ~/Downloads/deck.pptx ~/Downloads/report.pdf
```

It shims the two DOM globals Obsidian gets from Electron and otherwise runs
the real extractor code.

### Note on dependencies

The zip reader is hand-rolled (`src/zip.ts`) rather than JSZip. JSZip's
transitive dependencies create `<script>` elements as a legacy task-scheduling
trick, which gets plugins flagged by Obsidian's community-plugin review as
"code obfuscation" — a false positive that is simpler to avoid than to argue.
The only runtime dependency is `pdfjs-dist`, whose worker is inlined at build
time because a plugin release can only ship `main.js`, `manifest.json` and
`styles.css`.
