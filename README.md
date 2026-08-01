# Convert to Markdown

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

![A PowerPoint being converted to Markdown in Obsidian: the deck is picked from a
list, and the resulting note has the slide titles as headings, the bullets as
lists, the slide table as a Markdown table, and the deck's images embedded
alongside them.](docs/demo.gif)

## Installing

Not in the community plugin store yet, so install it by hand:

1. Copy `main.js` and `manifest.json` into
   `<vault>/.obsidian/plugins/convert-to-markdown/`
2. Settings → Community plugins → enable **Convert to Markdown**

Nothing else. No runtime to install, no binary to put on PATH, no account.
Desktop only — it uses Node's `zlib`, which Obsidian mobile doesn't have.

The first time you convert an *image*, there's a one-off engine download (see
[OCR](#ocr)); the notice shows its progress. Everything else works
immediately and offline.

## Usage

- Right-click a supported file in the file explorer → **Convert to Markdown**
- Or run **Convert to Markdown: Convert a file** from the command palette

The note is written next to the original (configurable), never overwriting an
existing note. Anything the converter dropped — images, hidden sheets, pages
with no text layer — is listed in a collapsed callout at the end.

## Compared to markitdown

The Obsidian plugins in this space wrap Microsoft's `markitdown`, which is one
abstraction over every format: it makes one-size-fits-all decisions about what
structure means, and those decisions are where the mess comes from.

**Nothing to install.** A markitdown-based plugin needs Python on the machine
and `pip install markitdown`, and fails with "Python is not installed or not
found at the configured path" until it has both. This one is plain JavaScript
inside Obsidian — which also means it works on a locked-down machine where
installing Python is the step that's blocked.

**Structure survives.** Headings keep their levels, lists stay lists, tables
stay tables, and images are written into the vault and embedded at the point
they appeared. Running the same PDF through both, markitdown returns the text
hard-wrapped exactly where the PDF's column broke, hyphens included —
`medica-` / `tions`, `occlu-` / `sion` — because a PDF line break is a
typesetting artifact it preserves rather than undoes. This one rejoins the
paragraph and repairs the hyphenation.

**Multi-column PDFs read in order.** Columns are detected per page and each
is read top to bottom before the next, so a two-column paper doesn't come out
interleaved. Full-width titles and headings are recognised as spanning the
columns and stay where they belong, and running headers are stripped before
the columns are worked out — otherwise a footer spread along the page bottom
lands in the middle of the text.

Per format, what's read and what it buys:

| Format | What it reads | What that buys |
| --- | --- | --- |
| `.docx` | `word/document.xml` paragraphs and `numbering.xml` | Real heading levels from Word's own styles; ordered vs. unordered lists; tables; hyperlinks; bold/italic |
| `.pptx` | Slide parts in `p:sldIdLst` order | One section per slide in *presentation* order, title placeholders as headings, speaker notes, slide tables |
| `.xlsx` | Worksheets, `sharedStrings.xml`, `styles.xml` | Dates instead of serial numbers, `27.38` instead of `27.383982300884924`, hidden helper sheets skipped |
| `.pdf` | The text layer, via pdf.js | Columns read in order, headings from font size, paragraphs rejoined across line breaks, de-hyphenation, running headers/footers dropped |
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

The download happens inside the first conversion, so that one takes noticeably
longer than the rest. The notice reports what it's doing while it waits
(`loading language traineddata — 61%`) rather than sitting on "Converting…".

Regions Tesseract is unsure of — lettering picked out of a photograph, logo
marks, JPEG artefacts — are dropped rather than written into the note as
gibberish, and counted in the conversion notes. Large display type reversed out
of a coloured background is the common thing OCR misses; check the note against
the image when the confidence warning appears.

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

## Known limits

- **Column detection is geometric, not semantic.** It reads the horizontal
  distribution of ink per page, so a layout no gutter runs through — text
  wrapped around a figure, a magazine-style collage — can still come out in
  the wrong order.
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
the real extractor code. `OCR_PROGRESS=1` prints the OCR stage reporting that
the plugin puts in its notice.

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

## License

MIT

## Third-party licenses

The released `main.js` is a bundle, so it carries these with it:

| Bundled | License |
| --- | --- |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) — PDF text and image extraction | Apache-2.0 |
| [tesseract.js](https://github.com/naptha/tesseract.js) — OCR API and worker | Apache-2.0 |
| [idb-keyval](https://github.com/jakearchibald/idb-keyval) — via tesseract.js, caches the OCR model | Apache-2.0 |
| [wasm-feature-detect](https://github.com/GoogleChromeLabs/wasm-feature-detect) — via tesseract.js, picks the SIMD build | Apache-2.0 |

Fetched on the first image conversion rather than redistributed here:

| Downloaded at runtime | License |
| --- | --- |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) — the WASM recogniser | Apache-2.0 |
| [tessdata](https://github.com/tesseract-ocr/tessdata_best) `eng.traineddata` — the English model | Apache-2.0 |

Apache-2.0 is compatible with this plugin's MIT license, and none of these ship
a NOTICE file that would require further attribution. Nothing else is bundled:
the zip reader and the PNG encoder are hand-rolled (`src/zip.ts`, `src/png.ts`)
precisely so there is nothing more to carry.
