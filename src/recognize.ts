import { createWorker, PSM } from "tesseract.js";
import { OcrEngineFiles, OcrProvider } from "./ocr";
import { squashSpaces } from "./markdown";

/**
 * Running Tesseract, shared by the two things that need reading rather than
 * parsing: an image file, and a page of a PDF that is only an image.
 *
 * Tesseract is not a language model. It is a classical OCR engine — line
 * segmentation followed by an LSTM character recogniser — compiled to WASM and
 * run locally. It takes no API key and the image never leaves the machine.
 * What it cannot do is understand: it gives back the words on the page, not
 * what they mean.
 */

// tesseract.js's worker script, inlined at build time (see
// esbuild.config.mjs). Its default is to pull the worker off a CDN; a plugin
// release can't ship a second JS file, and fetching executable code at
// runtime is worth avoiding, so it gets the same Blob-URL treatment as the
// pdf.js worker.
declare const __TESSERACT_WORKER_SOURCE__: string;

let workerUrl: string | null = null;

export interface Recognition {
  /** Recognised text, one entry per paragraph Tesseract's layout analysis found. */
  paragraphs: string[];
  /** Tesseract's own confidence for the whole image, 0–100. */
  confidence: number;
  /** Paragraphs discarded as too uncertain to be text at all. */
  discarded: number;
}

/**
 * Anything Tesseract is this unsure of is noise, not text — lettering picked
 * out of a photograph, a logo, JPEG artefacts along an edge. Keeping it turns
 * the note into gibberish that reads as if it were content.
 */
const MIN_PARAGRAPH_CONFIDENCE = 60;

export async function recognize(data: Buffer, ocr: OcrProvider): Promise<Recognition> {
  const engine = await ocr.resolve();
  const worker = await createWorker("eng", undefined, {
    ...workerOptions(),
    ...engineOptions(engine),
    logger: ({ status, progress }: { status: string; progress: number }) => ocr.report?.(status, progress),
  });

  try {
    // Tesseract's own default is to treat the image as one uniform block of
    // text, which flattens a page's headings, columns and captions into a
    // single run. AUTO runs its layout analysis first, which is what makes
    // paragraph structure available at all.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });

    // `blocks` is not part of the default output; without asking for it, the
    // only thing available is a flat string.
    const { data: result } = await worker.recognize(data, {}, { blocks: true, text: true });
    return { ...buildParagraphs(result.blocks ?? []), confidence: result.confidence ?? 0 };
  } finally {
    await worker.terminate();
  }
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface OcrLine {
  text: string;
  confidence: number;
  box: Box;
  /** Width of the line's first word, for deciding whether it would have fitted
   *  on the end of the line above. */
  firstWordWidth: number;
}

/**
 * How far apart two lines can sit and still belong to the same paragraph, as a
 * multiple of the typical line height. Ordinary leading is well under 1; a
 * paragraph break, a gap between UI elements or a change of section is well
 * over it.
 */
const MAX_LINE_GAP = 1.5;

/** How far two lines' left edges can differ and still be the same column. */
const COLUMN_TOLERANCE = 0.6;

/**
 * How much of the column a line must fill before it can be treated as having
 * wrapped at all. A heading or a one-word line stops far short of this, and no
 * amount of arithmetic about the following word should make it a paragraph
 * opener.
 */
const MIN_FILL_RATIO = 0.6;

/**
 * Rebuilds paragraphs from recognised lines, using where the lines sit rather
 * than trusting Tesseract's own paragraph and block division.
 *
 * That division is unreliable on exactly the images people convert. Tesseract
 * decides paragraphs from indentation and spacing rules meant for scanned
 * prose, and a screenshot is not scanned prose: on a three-line paragraph of a
 * web page it put the last line in a separate *block*, and on a chat
 * transcript it split one bubble across two blocks while merging a timestamp
 * and an unrelated name into one paragraph.
 *
 * The geometry says what the layout analysis didn't, and it is the same
 * reasoning the PDF extractor already uses on glyph positions: a line that
 * runs to the right margin was wrapped, so whatever comes next at the same
 * left margin continues it; a line that stops short ended its paragraph.
 */
function buildParagraphs(blocks: RecognisedBlock[]): { paragraphs: string[]; discarded: number } {
  const groups = readLines(blocks);
  if (groups.length === 0) return { paragraphs: [], discarded: 0 };

  const all = groups.flat();
  const lineHeight = median(all.map((line) => line.box.y1 - line.box.y0)) || 1;

  const units = groups.flatMap((group) => splitOnGaps(group, lineHeight));
  const merged = mergeWrapped(units, all, lineHeight);

  const paragraphs: string[] = [];
  let discarded = 0;

  for (const unit of merged) {
    // Tesseract emits one line per line of pixels; rejoining them stops the
    // note being hard-wrapped at whatever width the image happened to be.
    const text = repairVerticalStrokes(squashSpaces(unit.map((line) => line.text.trim()).join(" ")));
    if (text === "") continue;

    const confidence = average(unit.map((line) => line.confidence));
    if (confidence < MIN_PARAGRAPH_CONFIDENCE) discarded++;
    else paragraphs.push(text);
  }

  return { paragraphs, discarded };
}

/** Lines grouped as Tesseract grouped them, before the geometry is applied. */
function readLines(blocks: RecognisedBlock[]): OcrLine[][] {
  const groups: OcrLine[][] = [];

  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      const lines: OcrLine[] = [];
      for (const line of paragraph.lines ?? []) {
        const text = line.text.replace(/\s+/g, " ").trim();
        if (text === "" || !line.bbox) continue;
        const firstWord = line.words?.find((word) => (word.text ?? "").trim() !== "")?.bbox;
        lines.push({
          text,
          confidence: line.confidence ?? 0,
          box: line.bbox,
          // Falling back to the whole line is the conservative choice: a wider
          // "first word" makes the fit test harder to pass, so a line whose
          // words weren't reported never merges on a guess.
          firstWordWidth: firstWord ? firstWord.x1 - firstWord.x0 : line.bbox.x1 - line.bbox.x0,
        });
      }
      if (lines.length > 0) groups.push(lines);
    }
  }

  return groups;
}

/**
 * Breaks a group wherever its lines are too far apart to be consecutive.
 *
 * Tesseract will happily put a timestamp and the name of the person who spoke
 * eighty pixels below it into one paragraph, which then reads as a single
 * sentence that was never written.
 */
function splitOnGaps(lines: OcrLine[], lineHeight: number): OcrLine[][] {
  const units: OcrLine[][] = [[lines[0]]];

  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (current.box.y0 - previous.box.y1 > MAX_LINE_GAP * lineHeight) units.push([current]);
    else units[units.length - 1].push(current);
  }

  return units;
}

function mergeWrapped(units: OcrLine[][], all: OcrLine[], lineHeight: number): OcrLine[][] {
  const merged: OcrLine[][] = [];

  for (const unit of units) {
    const previous = merged[merged.length - 1];
    if (previous && continuesParagraph(previous, unit, all, lineHeight)) previous.push(...unit);
    else merged.push([...unit]);
  }

  return merged;
}

function continuesParagraph(previous: OcrLine[], next: OcrLine[], all: OcrLine[], lineHeight: number): boolean {
  const last = previous[previous.length - 1];
  const first = next[0];

  // Directly below, by no more than one line's worth of leading. A negative
  // gap means Tesseract returned the regions out of reading order, in which
  // case they are certainly not consecutive lines.
  const gap = first.box.y0 - last.box.y1;
  if (gap < 0 || gap > MAX_LINE_GAP * lineHeight) return false;

  // Same column: a continuation starts where the paragraph starts. This is
  // what keeps a right-aligned "Read" receipt — which ends flush against the
  // page edge and so looks like a wrapped line — from swallowing the next
  // speaker's name.
  if (Math.abs(first.box.x0 - previous[0].box.x0) > COLUMN_TOLERANCE * lineHeight) return false;

  // And the previous line ran out of room. The test is not "did it end near
  // the margin" — plenty of ragged-right text ends a line several characters
  // short — but "would the next word have fitted?". A line that stopped
  // because the following word wouldn't fit is a wrapped line; a line that
  // stopped with room to spare ended its paragraph on purpose.
  //
  // The margin comes from the other lines sharing this line's left edge rather
  // than from the page, since a screenshot holds several columns of different
  // widths.
  const left = previous[0].box.x0;
  const margin = rightMarginFor(left, all, lineHeight);
  const width = margin - left;
  if (width <= 0) return false;
  if ((last.box.x1 - left) / width < MIN_FILL_RATIO) return false;

  // A space is roughly a quarter of the line height in most faces; the exact
  // figure only matters when the next word would land within a space of the
  // margin, which is the case this is already treating as "didn't fit".
  return last.box.x1 + 0.25 * lineHeight + first.firstWordWidth > margin;
}

function rightMarginFor(left: number, all: OcrLine[], lineHeight: number): number {
  let margin = 0;
  for (const line of all) {
    if (Math.abs(line.box.x0 - left) <= COLUMN_TOLERANCE * lineHeight) margin = Math.max(margin, line.box.x1);
  }
  return margin;
}

/**
 * Puts back the capital `I` that Tesseract read as a vertical bar.
 *
 * In a sans-serif face a capital I has no serifs and no crossbar: it is a
 * plain vertical stroke, pixel-identical to `|` and near enough to a lowercase
 * `l`. Tesseract picks between them on context, and on UI screenshots — where
 * the word is very often the pronoun "I" starting a sentence — it frequently
 * picks wrong, so "I put together our plans" arrives as "| put together our
 * plans".
 *
 * The repair is deliberately narrow: only a bar standing alone as a word, and
 * only where a lowercase word follows it, which is the shape of the English
 * pronoun and not the shape of a table rule or a code fragment. A line that
 * looks like a table row is left alone entirely, since there the bars are
 * exactly what they appear to be.
 */
function repairVerticalStrokes(text: string): string {
  if (!/[|l]/.test(text)) return text;
  // Two or more free-standing bars on one line is a table, not a sentence.
  if ((text.match(/(?:^|\s)\|(?=\s|$)/g) ?? []).length >= 2) return text;

  return text.replace(/(^|[\s("'“‘])[|l](?=(?:['’](?:m|ve|ll|d|re)\b)?\s+[a-z])/g, "$1I");
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

interface RecognisedBlock {
  paragraphs?: {
    lines?: { text: string; confidence?: number; bbox?: Box; words?: { text?: string; bbox?: Box }[] }[];
  }[];
}

function workerOptions(): { workerPath?: string; workerBlobURL?: boolean } {
  // The Node harness (tools/convert.mjs) builds with an empty worker source
  // and can't run a Blob URL as a worker; tesseract.js's own node default
  // resolves to a real file there.
  if (__TESSERACT_WORKER_SOURCE__ === "") return {};

  if (!workerUrl) {
    const blob = new Blob([BLOB_PATH_SHIM, __TESSERACT_WORKER_SOURCE__], { type: "text/javascript" });
    workerUrl = URL.createObjectURL(blob);
  }
  return { workerPath: workerUrl, workerBlobURL: false };
}

/**
 * Lets the engine be handed to Tesseract as bytes instead of a download.
 *
 * Tesseract only accepts a *directory* for `langPath` — it appends
 * `/eng.traineddata` itself and fetches that. There's no directory to point
 * at when the bytes are already in memory, and a Blob URL can't have a path
 * appended to it. So the language data goes in as a Blob URL anyway, and the
 * shim below (running inside the worker) strips the filename Tesseract tacked
 * on before the fetch happens.
 *
 * `corePath` is easier: Tesseract loads it directly when it ends in `js`,
 * which a `#.js` fragment satisfies without changing what the URL resolves
 * to.
 */
function engineOptions(engine: OcrEngineFiles | null): Record<string, unknown> {
  if (!engine) return {};

  const core = URL.createObjectURL(new Blob([engine.core], { type: "text/javascript" }));
  const language = URL.createObjectURL(new Blob([engine.language], { type: "application/octet-stream" }));

  return {
    corePath: `${core}#.js`,
    langPath: language,
    // Keeps the appended filename predictable for the shim; gzipped data is
    // detected from its magic bytes regardless.
    gzip: false,
    // Nothing to cache — the bytes come from disk every time, and writing
    // them into IndexedDB as well would just duplicate them.
    cacheMethod: "none",
  };
}

/**
 * Runs inside the OCR worker, ahead of Tesseract's own code.
 *
 * Undoes the two path manipulations Tesseract performs on values that are
 * really Blob URLs: the `/eng.traineddata` it appends to `langPath`, and the
 * `#.js` fragment we added to `corePath` to satisfy its file-vs-directory
 * check. Both are string edits on a URL that is already exactly the resource
 * wanted.
 */
const BLOB_PATH_SHIM = `(() => {
  const nativeFetch = self.fetch.bind(self);
  self.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input && input.url;
    if (typeof url === "string") {
      const match = /^(blob:.*)\\/[^/]*\\.traineddata(\\.gz)?$/.exec(url);
      if (match) return nativeFetch(match[1], init);
    }
    return nativeFetch(input, init);
  };
  const nativeImportScripts = self.importScripts.bind(self);
  self.importScripts = (...urls) =>
    nativeImportScripts(...urls.map((url) =>
      typeof url === "string" && url.startsWith("blob:") ? url.split("#")[0] : url
    ));
})();
`;

/**
 * Wraps a provider so its progress messages say which page they're about.
 *
 * A one-page image is quick enough that "recognizing text — 40%" is enough.
 * Sixty scanned pages is several minutes, and without the page number the
 * notice looks identical from start to finish.
 */
export function forPage(ocr: OcrProvider, page: number, total: number): OcrProvider {
  return {
    resolve: () => ocr.resolve(),
    report: (status, progress) => ocr.report?.(`page ${page} of ${total} — ${status}`, progress),
  };
}
