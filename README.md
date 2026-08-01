# Doc to Markdown

Converts PDF, Word, PowerPoint, Excel and image files in your vault into
Markdown notes, images and all.

No LLM, no API key, no cloud service, no external binary. Nothing you convert
is uploaded anywhere — every byte is processed on your machine.

Documents (`.pdf`, `.docx`, `.pptx`, `.xlsx`) are parsed directly from their
own structure, which makes them fully deterministic and fully offline: the
same file always produces byte-identical Markdown.

Image files are the one exception, and differ on both counts. Pixels carry no
structure, so reading one means OCR — statistical rather than structural, and
occasionally wrong, which is why it reports its confidence. Tesseract is a
local neural recogniser, not a language model and not a service, but calling
it "no AI" would oversell it. It also downloads its engine the first time you
use it. Details under [OCR](#ocr).

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
| `.png` `.jpg` `.webp` `.gif` `.bmp` `.tiff` | Local OCR (Tesseract) | Text off a screenshot or photo, laid out as paragraphs rather than one line per pixel row |

Macro-enabled variants (`.docm`, `.pptm`, `.xlsm`) are the same parts plus a
VBA blob, and convert identically.

## Images

Images are pulled out of the source file, written to `<note name>
attachments/` beside the note, and embedded where they actually sat — a figure
inside a Word table cell comes out inside that table cell. Identical images are
written once no matter how many times they're used, so a logo on forty slides
is one file.

Word, PowerPoint and Excel store images in their original encoding, so those
come out untouched (`.jpeg` stays `.jpeg`). A PDF doesn't store files at all —
it stores decoded pixels — so images from a PDF are re-encoded as PNG. Images
under 64px on a side are treated as rules, bullets and icons and skipped.

Turn the whole thing off with **Extract images** in settings for text-only
notes.

## OCR

An image file has no structure to read, so converting one runs Tesseract — a
classical OCR engine (line segmentation plus an LSTM character recogniser)
compiled to WASM. It is not an LLM, takes no API key, and the image never
leaves your machine.

The engine and its English model are not shipped in the plugin — an Obsidian
release can only contain `main.js`, `manifest.json` and `styles.css` — so they
download from jsdelivr the first time you convert an image:

| What | Size | Cached in |
| --- | --- | --- |
| `tesseract-core-simd-lstm.wasm.js`, the recogniser | ~3.7 MB | Electron's HTTP cache |
| `eng.traineddata`, the English model | 5.0 MB | IndexedDB, by tesseract.js |

That traffic is one-way: it fetches the engine, it never sends the image.
After the first run OCR works with the network off, and nothing else in the
plugin touches the network at all.

### Locked-down machines

If that CDN is blocked — common on corporate networks — put the two files in a
vault folder and name it in **OCR engine folder** in settings. OCR then reads
them straight from disk and makes no network request at all, on the first run
or any other.

Download them once somewhere with access:

- `https://cdn.jsdelivr.net/npm/tesseract.js-core@7/tesseract-core-simd-lstm.wasm.js`
- `https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz`

Both go in the same folder, keeping their filenames (the `.gz` may be
unzipped, either works). If the folder is set but a file is missing, the
conversion says which one.

Regions Tesseract is unsure of — lettering picked out of a photograph, logo
marks, JPEG artefacts — are dropped rather than written into the note as
gibberish, and counted in the conversion notes. Large display type reversed out
of a coloured background is the common thing OCR misses; check the note against
the image when the confidence warning appears.

## Usage

- Right-click a supported file in the file explorer → **Convert to Markdown**
- Or run **Doc to Markdown: Convert a file to Markdown** from the command palette

The note is written next to the original (configurable), never overwriting an
existing note. Anything the converter dropped — images, hidden sheets, pages
with no text layer — is listed in a collapsed callout at the end.

## Known limits

- **Scanned PDFs are refused, not OCR'd.** A PDF that is only page images has
  no text layer, and it is reported as an error rather than silently written
  as an empty note. The OCR path exists but is not wired into the PDF
  extractor.
- **Windows metafiles (EMF/WMF)** can't be embedded — nothing in Obsidian
  renders them — so they're skipped and counted.
- **Excel formulas** export as their last-calculated value — the value Excel
  itself stored in the file.
- **Charts and embedded objects** in decks are skipped and counted; a chart is
  a data structure, not a picture, so there's nothing to embed.
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
PNG encoding for PDF images is hand-rolled too (`src/png.ts`), on top of the
`zlib` the zip reader already uses, so it works identically in Obsidian and in
the Node harness.

The runtime dependencies are `pdfjs-dist` and `tesseract.js`. Both normally
load their worker script from a separate file or a CDN at runtime; a plugin
release can only ship `main.js`, `manifest.json` and `styles.css`, so both
workers are inlined at build time and handed to the library as a Blob URL.
Tesseract's WASM engine and language data still come from a CDN on first use —
they're too large to inline, and the language data has to be fetched somehow.
