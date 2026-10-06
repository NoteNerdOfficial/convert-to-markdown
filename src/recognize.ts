import { createWorker, PSM, type Worker } from "tesseract.js";
import { findTables, LayoutItem, LayoutRow } from "./layout/tables";
import { escapeInline, squashSpaces, table } from "./markdown";
import { OcrEngineFiles, OcrProvider } from "./ocr";

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
  /** What was read, in reading order: paragraphs, and tables where the words line up as one. */
  blocks: OcrBlock[];
  /** Tesseract's own confidence for the whole image, 0–100. */
  confidence: number;
  /** Paragraphs discarded as too uncertain to be text at all. */
  discarded: number;
  /** Why tables weren't looked for, when they weren't. */
  tablesSkipped?: string;
  /**
   * Words read inside a table's area that aren't in the table — the pass
   * read for tables missed them. Named so the table can be checked.
   */
  unplaced: string[];
}

export type OcrBlock =
  | { kind: "text"; text: string }
  /** `confidence` is the recogniser's average over the table's words, 0–100. */
  | { kind: "table"; rows: string[][]; numeric: boolean[]; confidence: number };

/**
 * Below this average confidence a table read by OCR is flagged for checking.
 * Higher than the bar for running text: a misread letter in a sentence is
 * obvious, a misread digit in a column of amounts isn't.
 */
export const LOW_TABLE_CONFIDENCE = 80;

/** The recognised blocks as Markdown lines. */
export function recognitionMarkdown(recognition: Recognition): string[] {
  return recognition.blocks.flatMap((block) =>
    block.kind === "text"
      ? ["", escapeInline(block.text), ""]
      : ["", ...table(block.rows.map((row) => row.map((cell) => squashSpaces(escapeInline(cell)))), block.numeric), ""]
  );
}

/** Whether anything at all was read. */
export function hasBlocks(recognition: Recognition | undefined): boolean {
  return recognition !== undefined && recognition.blocks.length > 0;
}

/**
 * Anything Tesseract is this unsure of is noise, not text — lettering picked
 * out of a photograph, a logo, JPEG artefacts along an edge. Keeping it turns
 * the note into gibberish that reads as if it were content.
 */
const MIN_PARAGRAPH_CONFIDENCE = 60;

/**
 * The OCR engine itself couldn't be started — its files are missing from the
 * configured folder, or the download was blocked — as opposed to one image
 * failing to recognise. The difference matters to anything reading several
 * images: an engine that won't start fails the same way on every one of them,
 * and the reason is a setting or the network, not the pages.
 */
export class OcrEngineError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "OcrEngineError";
  }
}

export async function recognize(data: Buffer, ocr: OcrProvider): Promise<Recognition> {
  let worker: Worker;
  try {
    const engine = await ocr.resolve();
    worker = await createWorker("eng", undefined, {
      ...workerOptions(),
      ...engineOptions(engine),
      logger: ({ status, progress }: { status: string; progress: number }) => ocr.report?.(status, progress),
    });
  } catch (error) {
    throw new OcrEngineError(error);
  }

  try {
    // Tesseract's own default is to treat the image as one uniform block of
    // text, which flattens a page's headings, columns and captions into a
    // single run. AUTO runs its layout analysis first, which is what makes
    // paragraph structure available at all.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });

    // `blocks` is not part of the default output; without asking for it, the
    // only thing available is a flat string.
    const { data: result } = await worker.recognize(data, {}, { blocks: true, text: true });
    const text = result.blocks ?? [];

    // That same layout analysis is what breaks tables: it cuts a column of
    // figures into blocks of its own, and a narrow one — the whole-number
    // part of a receipt's prices — gets read as letters. Read as one uniform
    // block instead, every row of a table comes back as a line, digits
    // intact. That costs a second pass, so it's only made when the first
    // shows rows with separate runs of text in them.
    let tables = text;
    if (mayHoldTable(text)) {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
      tables = (await worker.recognize(data, {}, { blocks: true })).data.blocks ?? [];
    }
    return { ...readBlocks(text, tables), confidence: result.confidence ?? 0 };
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
  /** Tesseract's own line, so that lines read into a table can be left out of the paragraphs. */
  source: RecognisedLine;
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
function buildParagraphs(
  blocks: RecognisedBlock[],
  inTables: Set<RecognisedLine>
): { paragraphs: { text: string; box: Box }[]; discarded: number } {
  const groups = readLines(blocks)
    .map((group) => group.filter((line) => !inTables.has(line.source)))
    .filter((group) => group.length > 0);
  if (groups.length === 0) return { paragraphs: [], discarded: 0 };

  const all = groups.flat();
  const lineHeight = median(all.map((line) => line.box.y1 - line.box.y0)) || 1;

  const units = groups.flatMap((group) => splitOnGaps(group, lineHeight));
  const merged = mergeWrapped(units, all, lineHeight);

  const paragraphs: { text: string; box: Box }[] = [];
  let discarded = 0;

  for (const unit of merged) {
    // Tesseract emits one line per line of pixels; rejoining them stops the
    // note being hard-wrapped at whatever width the image happened to be.
    const text = repairVerticalStrokes(squashSpaces(unit.map((line) => line.text.trim()).join(" ")));
    if (text === "") continue;

    const confidence = average(unit.map((line) => line.confidence));
    if (confidence < MIN_PARAGRAPH_CONFIDENCE) discarded++;
    else paragraphs.push({ text, box: unit[0].box });
  }

  return { paragraphs, discarded };
}

/**
 * Paragraphs and tables, in reading order.
 *
 * Tesseract's own layout analysis is no help with tables: it reads a table as
 * a column of text blocks, so a statement comes out as every date, then
 * every description, then every amount. The words themselves still sit where
 * they were printed, though, and that's all the table detector the PDF
 * extractor uses needs. So the words are laid out again as rows across the
 * page, the same detector finds the tables, and the lines of the ordinary
 * reading that fall inside one are left out of the paragraphs.
 *
 * `text` is the ordinary reading; `tables` is the reading the rows are taken
 * from, the same one unless a second pass was made for tables.
 */
function readBlocks(text: RecognisedBlock[], tables: RecognisedBlock[]): Omit<Recognition, "confidence"> {
  const { rows, tilt, skipped } = layoutRows(tables);
  const straighten = (x: number, y: number) => ({ x: x + tilt * y, y: y - tilt * x });

  const found: { block: OcrBlock; box: Box }[] = [];
  for (const detected of skipped ? [] : findTables(rows)) {
    const words = rows.slice(detected.first, detected.last + 1).flatMap((row) => row.items as OcrWord[]);
    const first = rows[detected.first];
    const last = rows[detected.last];
    found.push({
      block: { kind: "table", rows: detected.rows, numeric: detected.numeric, confidence: average(words.map((w) => w.confidence)) },
      // From the top of the first row's letters to below the last row's
      // descenders, in straightened coordinates.
      box: {
        x0: detected.left,
        x1: detected.right,
        y0: first.y - Math.max(...first.items.map((item) => item.size)),
        y1: last.y + 0.5 * Math.max(...last.items.map((item) => item.size)),
      },
    });
  }

  // A line of the ordinary reading belongs to a table when its middle falls
  // inside one.
  const inside = (bbox: Box) => {
    const middle = straighten((bbox.x0 + bbox.x1) / 2, (bbox.y0 + bbox.y1) / 2);
    return found.find(({ box }) => middle.x >= box.x0 && middle.x <= box.x1 && middle.y >= box.y0 && middle.y <= box.y1);
  };
  const inTables = new Set<RecognisedLine>();
  const unplaced: string[] = [];
  for (const line of text.flatMap((block) => (block.paragraphs ?? []).flatMap((paragraph) => paragraph.lines ?? []))) {
    if (!line.bbox || !inside(line.bbox)) continue;
    inTables.add(line);
    // When the table came from a second reading, anything the first read
    // confidently there should be in it somewhere. What isn't is named
    // rather than lost with the line it was on.
    if (tables === text) continue;
    for (const word of line.words ?? []) {
      const token = (word.text ?? "").trim();
      const table = word.bbox && inside(word.bbox);
      if (!table || table.block.kind !== "table" || token === "" || (word.confidence ?? 0) < MIN_PARAGRAPH_CONFIDENCE) continue;
      const cells = table.block.rows.flat();
      if (!cells.some((cell) => cell.includes(token))) unplaced.push(token);
    }
  }

  const { paragraphs, discarded } = buildParagraphs(text, inTables);
  const out: { block: OcrBlock; box: Box }[] = paragraphs.map((paragraph) => {
    const topLeft = straighten(paragraph.box.x0, paragraph.box.y0);
    const bottomRight = straighten(paragraph.box.x1, paragraph.box.y1);
    return {
      block: { kind: "text", text: paragraph.text },
      box: { x0: topLeft.x, y0: topLeft.y, x1: bottomRight.x, y1: bottomRight.y },
    };
  });
  // Each table goes in before the first paragraph below it that shares some
  // of its width, as the PDF extractor places them.
  for (const entry of found) {
    const next = out.findIndex(
      ({ block, box }) =>
        block.kind === "text" && box.y0 > entry.box.y0 && box.x0 < entry.box.x1 && box.x1 > entry.box.x0
    );
    out.splice(next === -1 ? out.length : next, 0, entry);
  }

  return {
    blocks: out.map((entry) => entry.block),
    discarded,
    unplaced,
    ...(skipped ? { tablesSkipped: skipped } : {}),
  };
}

/** Rows with separate runs of text this many times over hint at a table. */
const TABLE_HINT_ROWS = 3;

/** Whether the ordinary reading hints at a table worth a second pass. */
function mayHoldTable(blocks: RecognisedBlock[]): boolean {
  const { rows, skipped } = layoutRows(blocks);
  return !skipped && rows.filter((row) => row.items.length > 1).length >= TABLE_HINT_ROWS;
}

interface OcrWord extends LayoutItem {
  confidence: number;
}

/**
 * Words below this confidence are left out of table layout: specks and
 * smudges read as letters. Set low on purpose — a word read badly is still
 * in the note, marked by the table's confidence, where a word left out would
 * just be missing.
 */
const MIN_WORD_CONFIDENCE = 10;

/** A table's border, read as text. */
const RULE = /^[|_]+$/;

/**
 * How far, in line heights, baselines can disagree across the page once
 * the page's overall tilt is taken out, before rows can't be trusted.
 */
const MAX_WARP = 0.5;

/**
 * The page's words as rows across the page, in coordinates that grow down
 * the page as the table detector expects.
 *
 * A scan or a photo is rarely square to the page, and the word boxes
 * Tesseract reports are in the image's own coordinates, so a row of a table
 * runs uphill or down. Over a page's width, a tilt of a degree or two moves
 * a row by more than its own height — enough to tear it in half. So the
 * words are first turned back by the page's tilt, measured as the median
 * slope of Tesseract's baselines. What that can't fix is a page whose lines
 * disagree with each other — a photo taken at an angle, paper that curls —
 * and there tables aren't looked for at all, and the note says why.
 */
function layoutRows(blocks: RecognisedBlock[]): {
  rows: LayoutRow[];
  /** The page's tilt, as the slope of its baselines. */
  tilt: number;
  skipped?: string;
} {
  const lines = blocks.flatMap((block) => (block.paragraphs ?? []).flatMap((paragraph) => paragraph.lines ?? []));
  const sloped = lines.filter((line) => line.baseline && line.baseline.x1 - line.baseline.x0 > 0);
  const slopes = sloped.map((line) => {
    const { x0, y0, x1, y1 } = line.baseline as Box;
    return (y1 - y0) / (x1 - x0);
  });
  const tilt = median(slopes);
  const height = median(lines.map(lineHeight)) || 1;

  const words = lines.flatMap((line) => (line.words ?? []).map((word) => ({ word, line })));
  const xs = words.flatMap(({ word }) => (word.bbox ? [word.bbox.x0, word.bbox.x1] : []));
  const width = xs.length > 0 ? Math.max(...xs) - Math.min(...xs) : 0;
  const warp = sloped.filter((_, index) => Math.abs(slopes[index] - tilt) * width > MAX_WARP * height).length;
  if (sloped.length >= 3 && warp > sloped.length * 0.25) {
    return {
      rows: [],
      tilt,
      skipped: "its lines aren't straight across the page — a photo taken at an angle, or paper that isn't flat",
    };
  }

  // Turning the page back by its tilt: for angles this small, shifting each
  // point by the slope is the rotation to well under a pixel.
  const placed: { word: OcrWord; y: number }[] = [];
  for (const { word, line } of words) {
    const text = (word.text ?? "").trim();
    if (!word.bbox || text === "" || RULE.test(text) || (word.confidence ?? 0) < MIN_WORD_CONFIDENCE) continue;
    const { x0, x1 } = word.bbox;
    const baseline = line.baseline ?? { x0, y0: word.bbox.y1, x1, y1: word.bbox.y1 };
    const along = (x0 + x1) / 2;
    const y = baseline.y0 + ((baseline.y1 - baseline.y0) / Math.max(1, baseline.x1 - baseline.x0)) * (along - baseline.x0);
    placed.push({
      word: { text, x: x0 + tilt * y, width: x1 - x0, size: lineHeight(line), confidence: word.confidence ?? 0 },
      y: y - tilt * along,
    });
  }

  placed.sort((a, b) => a.y - b.y || a.word.x - b.word.x);
  const rows: LayoutRow[] = [];
  let current: typeof placed = [];
  const flush = () => {
    if (current.length === 0) return;
    const runs = joinWords(current.map((entry) => entry.word).sort((a, b) => a.x - b.x));
    rows.push({ items: runs, y: median(current.map((entry) => entry.y)) });
    current = [];
  };
  for (const entry of placed) {
    if (current.length > 0 && entry.y - current[0].y > 0.5 * entry.word.size) flush();
    current.push(entry);
  }
  flush();
  return { rows, tilt };
}

/**
 * Words closer than this, in line heights, are one run of text. Measured:
 * the gap between words in OCR'd prose sits around a third of a line
 * height, and justified text stretches it to just under one; a table's
 * columns are almost always further apart than that.
 */
const WORD_RUN_GAP = 1;

/**
 * A row's words joined into runs of text.
 *
 * Tesseract reports single words, where a PDF reports runs — a phrase, a
 * cell. Handed single words, the table detector would see every word space
 * as a possible column boundary, and three lines of a letterhead can line up
 * their word spaces by chance. Joined into runs first, an OCR'd row looks
 * like a PDF's, and the detector treats both the same. A table whose columns
 * sit closer together than a word space stretches is the price: it reads as
 * text.
 */
function joinWords(words: OcrWord[]): OcrWord[] {
  const runs: { word: OcrWord; confidences: number[] }[] = [];
  for (const word of words) {
    const last = runs[runs.length - 1];
    if (last && word.x - (last.word.x + last.word.width) <= WORD_RUN_GAP * Math.max(word.size, last.word.size)) {
      last.word = {
        text: `${last.word.text} ${word.text}`,
        x: last.word.x,
        width: word.x + word.width - last.word.x,
        size: Math.max(word.size, last.word.size),
        confidence: 0,
      };
      last.confidences.push(word.confidence);
    } else {
      runs.push({ word: { ...word }, confidences: [word.confidence] });
    }
  }
  return runs.map((run) => ({ ...run.word, confidence: average(run.confidences) }));
}

/**
 * A line's height in pixels — the unit the table detector measures in. The
 * row height Tesseract measured, where it gave one, is steadier than the
 * box, which grows with every descender and accent on the line.
 */
function lineHeight(line: RecognisedLine): number {
  const measured = line.rowAttributes?.rowHeight;
  if (measured && measured > 0) return measured;
  return line.bbox ? line.bbox.y1 - line.bbox.y0 : 0;
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
          source: line,
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
  paragraphs?: { lines?: RecognisedLine[] }[];
}

interface RecognisedLine {
  text: string;
  confidence?: number;
  bbox?: Box;
  baseline?: Box;
  rowAttributes?: { rowHeight?: number };
  words?: { text?: string; bbox?: Box; confidence?: number }[];
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
