import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { AssetSink } from "../assets";
import { bullet, escapeInline, heading, joinBlocks, squashSpaces } from "../markdown";
import { CDN_OCR, OcrProvider } from "../ocr";
import { encodePng } from "../png";
import { forPage, recognize, Recognition } from "../recognize";
import { ExtractResult } from "./types";

// pdfjs-dist's worker script, inlined at build time by esbuild (see
// esbuild.config.mjs) because a plugin release can't ship a second JS file.
declare const __PDF_WORKER_SOURCE__: string;

let workerUrl: string | null = null;

function ensureWorker(): void {
  if (workerUrl) return;
  // The Node harness (tools/convert.mjs) builds with an empty worker source
  // and has no Worker to run it in; leaving workerSrc unset lets pdf.js fall
  // back to its in-process fake worker there.
  if (__PDF_WORKER_SOURCE__ === "") return;
  const blob = new Blob([__PDF_WORKER_SOURCE__], { type: "text/javascript" });
  workerUrl = URL.createObjectURL(blob);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

/**
 * PDF → Markdown from the text layer.
 *
 * A PDF has no notion of a heading, a paragraph or a list — it has glyphs at
 * coordinates. Everything structural here is reconstructed from geometry:
 * items sharing a baseline are a line, lines are grouped into paragraphs by
 * where they stop short of the margin, and headings are lines set noticeably
 * larger than the document's body size. That's the same approach
 * `pdftotext -layout` takes, and it's fully deterministic — the same file
 * always produces the same Markdown.
 *
 * The one thing geometry can't do is read a scan. A page that is only an image
 * has no glyphs to position, so those pages — and only those — go through OCR
 * instead, the same recogniser the image extractor uses. That keeps the
 * distinction honest: a PDF with a text layer is still parsed exactly and
 * deterministically, and the statistical path is used only where there is no
 * alternative to it. Which pages were read that way is reported, because they
 * are the pages that can be wrong.
 */
export async function extractPdf(
  data: Buffer,
  assets: AssetSink,
  ocr: OcrProvider = CDN_OCR
): Promise<ExtractResult> {
  ensureWorker();

  const document = await pdfjsLib.getDocument({
    // pdf.js takes ownership of the buffer it's handed, so pass a copy — the
    // caller's Buffer would otherwise come back detached.
    data: new Uint8Array(data),
    // Forces decoded images to arrive as raw pixel buffers rather than
    // ImageBitmaps. Obsidian's Electron supports OffscreenCanvas and Node
    // doesn't, so leaving this on would give the two environments different
    // image objects — and make the extractor untestable outside Obsidian.
    isOffscreenCanvasSupported: false,
  }).promise;

  try {
    const pageRows: PositionedItem[][][] = [];
    const pageImages: string[][] = [];
    /** Pages with no glyphs at all — a scan, or an image-only export. */
    const imageOnly: number[] = [];
    let skippedImages = 0;

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const positioned = positionItems(content.items.filter(isTextItem));
        pageRows.push(groupRows(positioned));

        if (positioned.length === 0) {
          // The page is a picture of a page. Its images aren't figures to
          // embed alongside the text — they *are* the text, and embedding a
          // full-page scan of every page would bury the note it produces. They
          // go to the recogniser in a second pass instead, so that only the
          // pages that need it pay for holding a raster in memory.
          imageOnly.push(pageNumber);
          pageImages.push([]);
        } else {
          const extracted = await extractPageImages(page, assets);
          pageImages.push(extracted.embeds);
          skippedImages += extracted.skipped;
        }
      } finally {
        page.cleanup();
      }
    }

    const scanned = await readScannedPages(document, imageOnly, ocr);

    // Running headers and footers are found on the naive full-width rows and
    // dropped before columns are worked out. A three-part footer spread along
    // the page bottom is one row here; once the page is split into columns it
    // becomes three fragments, each landing at the end of a different column,
    // in the middle of the text.
    const repeated = repeatedEdgeText(pageRows.map((rows) => rows.map(toLine)));
    const pages = pageRows.map((rows) => buildPage(withoutFurniture(rows, repeated)));

    const allLines = pages.flat();
    if (allLines.length === 0 && scanned.size === 0) {
      throw new Error(
        "this PDF has no text at all — no text layer, and no page image that OCR could read either"
      );
    }

    const bodySize = modeFontSize(allLines);
    const bodyWidth = medianLineWidth(allLines);

    const lines: string[] = [];
    pages.forEach((pageLines, index) => {
      const recognised = scanned.get(index + 1);
      if (recognised) {
        for (const paragraph of recognised.paragraphs) lines.push("", escapeInline(paragraph), "");
      }
      lines.push(...renderPage(pageLines, bodySize, bodyWidth));
      // A PDF's drawing operations don't interleave with its text in reading
      // order, so there's no honest position for a figure within the page —
      // they go after the page's text.
      for (const embed of pageImages[index]) lines.push("", embed, "");
    });

    return {
      markdown: joinBlocks(lines),
      warnings: pdfWarnings(document.numPages, pages, scanned, skippedImages),
      frontmatter: coverageOf(document.numPages, pages, scanned),
    };
  } finally {
    await document.destroy();
  }
}

/**
 * How much of the document made it across, at the top of the note rather than
 * in a footnote after two thousand lines. A page that produced nothing at all
 * is the thing a reader most needs to know about before reading the rest.
 */
function coverageOf(pageCount: number, pages: Line[][], scanned: Map<number, Recognition>): Record<string, string> {
  const converted = pages.filter((page, index) => page.length > 0 || hasText(scanned.get(index + 1))).length;
  const frontmatter: Record<string, string> = { pages_converted: `${converted}/${pageCount}` };
  if (scanned.size > 0) frontmatter.pages_read_by_ocr = String([...scanned.values()].filter(hasText).length);
  return frontmatter;
}

function hasText(recognition: Recognition | undefined): boolean {
  return recognition !== undefined && recognition.paragraphs.length > 0;
}

function pdfWarnings(
  pageCount: number,
  pages: Line[][],
  scanned: Map<number, Recognition>,
  skippedImages: number
): string[] {
  const warnings = ["Vector graphics and charts drawn as line art are not extracted."];

  if (skippedImages > 0) {
    warnings.push(
      `${skippedImages} image${skippedImages === 1 ? "" : "s"} skipped (too small to be content, or an unsupported colour format).`
    );
  }

  const read = [...scanned.entries()].filter(([, recognition]) => hasText(recognition));
  if (read.length > 0) {
    const confidences = read.map(([, recognition]) => recognition.confidence);
    const lowest = Math.round(Math.min(...confidences));
    warnings.push(
      `${read.length} page${read.length === 1 ? "" : "s"} had no text layer and ${
        read.length === 1 ? "was" : "were"
      } read by OCR instead (${listPages(read.map(([page]) => page))}). That part of the note is a recognition ` +
        `rather than an extraction and can be wrong — lowest confidence was ${lowest}%.`
    );

    const discarded = read.reduce((total, [, recognition]) => total + recognition.discarded, 0);
    if (discarded > 0) {
      warnings.push(
        `${discarded} region${discarded === 1 ? "" : "s"} on those pages were too unclear to read and were ` +
          "dropped rather than guessed at."
      );
    }
  }

  // Named, not counted: which pages came out empty is what makes it possible
  // to go back to the original and see what was on them.
  const blank = pages
    .map((page, index) => (page.length === 0 && !hasText(scanned.get(index + 1)) ? index + 1 : 0))
    .filter((page) => page > 0);
  if (blank.length > 0) {
    warnings.push(
      `${blank.length} of ${pageCount} pages produced nothing — no text layer, and nothing OCR could read ` +
        `(${listPages(blank)}). They may be blank, or artwork with no lettering.`
    );
  }

  return warnings;
}

function listPages(pages: number[]): string {
  const shown = pages.slice(0, 12).join(", ");
  return pages.length > 12 ? `pages ${shown}, …` : `page${pages.length === 1 ? "" : "s"} ${shown}`;
}

/**
 * Reads the pages that have no text layer.
 *
 * A scanned page is a single image painted across the whole page, so the image
 * is the page — there is nothing to rasterise and no canvas needed. Pulling
 * the image straight out of the PDF also means this behaves identically in
 * Obsidian and in the Node harness, which is the same reason PDF figures are
 * re-encoded with the hand-rolled PNG writer rather than through a canvas.
 *
 * Done as a second pass over just these pages: a two-hundred-page scan would
 * otherwise mean holding two hundred full-page rasters while the first pass
 * finished.
 */
async function readScannedPages(
  document: PDFDocumentProxy,
  pageNumbers: number[],
  ocr: OcrProvider
): Promise<Map<number, Recognition>> {
  const results = new Map<number, Recognition>();

  for (const [index, pageNumber] of pageNumbers.entries()) {
    const page = await document.getPage(pageNumber);
    try {
      const rasters = await pageRasters(page);
      if (rasters.length === 0) continue;

      const recognitions: Recognition[] = [];
      for (const raster of rasters) {
        recognitions.push(await recognize(raster, forPage(ocr, index + 1, pageNumbers.length)));
      }

      // A page split into horizontal strips by the scanner is several images
      // in reading order; merging them keeps the page one page.
      results.set(pageNumber, {
        paragraphs: recognitions.flatMap((recognition) => recognition.paragraphs),
        confidence: Math.min(...recognitions.map((recognition) => recognition.confidence)),
        discarded: recognitions.reduce((total, recognition) => total + recognition.discarded, 0),
      });
    } catch {
      // One unreadable page shouldn't cost the other hundred; it is reported
      // as producing nothing, which is what happened.
    } finally {
      page.cleanup();
    }
  }

  return results;
}

/**
 * The images on a page, largest first, as PNG.
 *
 * Bilevel images are included here and nowhere else. A 1-bit image is normally
 * a stencil mask and never worth embedding, but a fax-style scan — CCITT G4,
 * the most common thing in a scanned archive — is bilevel by definition, and
 * refusing it would mean refusing exactly the documents this path exists for.
 */
async function pageRasters(page: PDFPageProxy): Promise<Buffer[]> {
  let operatorList;
  try {
    operatorList = await page.getOperatorList();
  } catch {
    return [];
  }

  const { OPS } = pdfjsLib;
  const seen = new Set<string>();
  const found: { png: Buffer; area: number }[] = [];

  for (let i = 0; i < operatorList.fnArray.length; i++) {
    if (operatorList.fnArray[i] !== OPS.paintImageXObject) continue;

    const objId = imageObjectId(operatorList, i);
    if (!objId || seen.has(objId)) continue;
    seen.add(objId);

    const image = await awaitImage(page, objId);
    const png = toPng(image, { allowBilevel: true });
    if (png && image) found.push({ png, area: image.width * image.height });
  }

  // Largest first, so a page with a logo in the corner recognises the scan
  // before the logo. Anything much smaller than the biggest image is
  // decoration rather than another strip of the page.
  found.sort((a, b) => b.area - a.area);
  const largest = found[0]?.area ?? 0;
  return found.filter((image) => image.area >= largest * 0.2).map((image) => image.png);
}

/**
 * Images below this on either side are rules, bullets, icons and spacer
 * pixels — decoration that would bury the real figures.
 */
const MIN_IMAGE_SIDE = 64;

/**
 * Pulls the raster images off a page.
 *
 * A PDF references images as XObjects painted by the page's operator list, so
 * the only way to find them is to walk that list and look each object up.
 * pdf.js hands back a decoded pixel buffer rather than the original file, so
 * they're re-encoded as PNG on the way out.
 */
async function extractPageImages(
  page: PDFPageProxy,
  assets: AssetSink
): Promise<{ embeds: string[]; skipped: number }> {
  const embeds: string[] = [];
  let skipped = 0;

  let operatorList;
  try {
    operatorList = await page.getOperatorList();
  } catch {
    // A page whose content stream fails to parse still had usable text; the
    // images are the only casualty.
    return { embeds, skipped };
  }

  const { OPS } = pdfjsLib;
  const seen = new Set<string>();

  for (let i = 0; i < operatorList.fnArray.length; i++) {
    if (operatorList.fnArray[i] !== OPS.paintImageXObject) continue;

    const objId = imageObjectId(operatorList, i);
    if (!objId || seen.has(objId)) continue;
    seen.add(objId);

    const png = toPng(await awaitImage(page, objId));
    if (!png) {
      skipped++;
      continue;
    }

    const embed = await assets.save(png, "png");
    if (embed) embeds.push(embed);
    else skipped++;
  }

  return { embeds, skipped };
}

interface DecodedImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | null;
}

/**
 * The object id an image-painting operator's first argument carries.
 *
 * pdf.js types `argsArray` as `Array<any>` — an operator's arguments are
 * whatever shape that operator needs, and there's no single interface for
 * all of them — so reading it back out narrowed to the one shape this code
 * actually expects keeps that `any` from spreading into the caller.
 */
function imageObjectId(operatorList: { argsArray: unknown[] }, index: number): string | null {
  const args = operatorList.argsArray[index];
  const id = Array.isArray(args) ? (args[0] as unknown) : undefined;
  return typeof id === "string" ? id : null;
}

/** Long enough for a large image to be decoded, short enough not to hang. */
const IMAGE_WAIT_MS = 20000;

/**
 * Fetches a decoded image, waiting for it if it hasn't arrived yet.
 *
 * pdf.js decodes images in its worker and pushes them across asynchronously,
 * so an image referenced by the operator list is very often not in the object
 * store at the moment the list resolves — the operator list contains an
 * explicit `dependency` entry saying exactly that, and a renderer is expected
 * to wait. Which images have arrived by then depends on the encoding: a JPEG
 * passes straight through and is usually ready, while anything pdf.js has to
 * decode itself is usually not.
 *
 * Checking `has()` and moving on therefore drops images by codec — and drops
 * them silently, since nothing is left to count.
 */
function awaitImage(page: PDFPageProxy, objId: string): Promise<DecodedImage | undefined> {
  // `g_`-prefixed ids are shared across pages and live on the document.
  const store = objId.startsWith("g_") ? page.commonObjs : page.objs;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (image: DecodedImage | undefined) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(image);
    };
    // `window.setTimeout`, not the bare global: this can run against a popout
    // window's own `document`/`window`, and the timer has to belong to it.
    const timer = window.setTimeout(() => finish(undefined), IMAGE_WAIT_MS);

    try {
      if (store.has(objId)) finish(store.get(objId) as DecodedImage);
      else store.get(objId, (image: unknown) => finish(image as DecodedImage));
    } catch {
      // An id the worker never sent at all.
      finish(undefined);
    }
  });
}

/**
 * Converts a pdf.js image object to PNG bytes, or null if it isn't a picture
 * worth keeping.
 *
 * Only the two truecolour kinds are handled. The third, 1-bit greyscale, is
 * almost always a stencil mask — the shape used to clip another image or to
 * paint a solid colour through — rather than an image anyone wants in a note.
 */
function toPng(image: DecodedImage | undefined, options: { allowBilevel?: boolean } = {}): Buffer | null {
  if (!image?.data) return null;
  const { width, height, kind, data } = image;
  if (width < MIN_IMAGE_SIDE || height < MIN_IMAGE_SIDE) return null;

  const { GRAYSCALE_1BPP, RGB_24BPP, RGBA_32BPP } = pdfjsLib.ImageKind;

  if (kind === RGBA_32BPP) {
    if (data.length < width * height * 4) return null;
    return encodePng(width, height, data);
  }

  if (kind === RGB_24BPP) {
    if (data.length < width * height * 3) return null;
    const rgba = new Uint8Array(width * height * 4);
    for (let pixel = 0, source = 0, target = 0; pixel < width * height; pixel++) {
      rgba[target++] = data[source++];
      rgba[target++] = data[source++];
      rgba[target++] = data[source++];
      rgba[target++] = 0xff;
    }
    return encodePng(width, height, rgba);
  }

  if (kind === GRAYSCALE_1BPP && options.allowBilevel) {
    return bilevelToPng(width, height, data);
  }

  return null;
}

/**
 * Expands a 1-bit image to RGBA.
 *
 * Rows are packed to whole bytes and padded at the end, so the row stride has
 * to be computed rather than derived from the width. A set bit is white, which
 * is pdf.js's convention for this kind and the opposite of what "1 bit set"
 * suggests.
 */
function bilevelToPng(width: number, height: number, data: Uint8Array): Buffer | null {
  const stride = (width + 7) >> 3;
  if (data.length < stride * height) return null;

  const rgba = new Uint8Array(width * height * 4);
  let target = 0;
  for (let row = 0; row < height; row++) {
    const rowStart = row * stride;
    for (let column = 0; column < width; column++) {
      const bit = (data[rowStart + (column >> 3)] >> (7 - (column & 7))) & 1;
      const value = bit ? 0xff : 0x00;
      rgba[target++] = value;
      rgba[target++] = value;
      rgba[target++] = value;
      rgba[target++] = 0xff;
    }
  }
  return encodePng(width, height, rgba);
}

/** Rows this far from the top or bottom of a page can be page furniture. */
const EDGE_ROWS = 2;

/**
 * Text that repeats at the top or bottom of page after page — the running
 * header, the footer, the page number.
 *
 * A PDF marks none of it, so the only signal is repetition: the same line in
 * the same position on most pages, ignoring the number that changes.
 */
function repeatedEdgeText(pages: (Line | null)[][]): Set<string> {
  const counts = new Map<string, number>();

  for (const page of pages) {
    // Count each distinct line once per page, so a page that happens to
    // repeat a phrase twice doesn't vote twice.
    for (const key of new Set(edgesOf(page).map((line) => line && furnitureKey(line.text)))) {
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // Needs to appear on most pages *and* on enough pages for the repetition to
  // mean anything — a 2-page document has no reliable signal here.
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  return new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
}

/** The rows of a page that survive furniture removal, flattened to items. */
function withoutFurniture(rows: PositionedItem[][], repeated: Set<string>): PositionedItem[] {
  if (repeated.size === 0) return rows.flat();

  const keep = rows.filter((row, index) => {
    const atEdge = index < EDGE_ROWS || index >= rows.length - EDGE_ROWS;
    if (!atEdge) return true;
    const line = toLine(row);
    return !line || !repeated.has(furnitureKey(line.text));
  });
  return keep.flat();
}

function edgesOf<T>(page: T[]): T[] {
  return [...page.slice(0, EDGE_ROWS), ...page.slice(-EDGE_ROWS)];
}

/**
 * A footer's identity, independent of where its parts sit on the page.
 *
 * Bound documents alternate the layout on facing pages, so the same footer
 * arrives as "Winter 2007 … 27" on one page and "28 … Winter 2007" on the
 * next. Comparing the words as an unordered set collapses the two, where
 * comparing the text would see two different footers each appearing on half
 * the pages — and drop neither.
 */
function furnitureKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, "")
    .split(/\s+/)
    .filter((word) => word !== "")
    .sort()
    .join(" ");
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

interface Line {
  text: string;
  /** Largest glyph height on the line — what makes a heading look like one. */
  size: number;
  /** Baseline in PDF user space, where larger is further up the page. */
  top: number;
  /** Left edge in PDF user space, used to detect indented blocks. */
  left: number;
  right: number;
}

interface PositionedItem {
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

/** Text items reduced to what the layout reconstruction actually reads. */
function positionItems(items: TextItem[]): PositionedItem[] {
  return items
    .filter((item) => item.str !== "")
    .map((item) => ({
      text: item.str,
      x: item.transform[4] as number,
      y: item.transform[5] as number,
      width: item.width,
      size: Math.abs(item.transform[3] as number) || item.height,
    }));
}

/**
 * A page's lines, in reading order.
 *
 * Reading order is the whole difficulty. Text items carry positions, not
 * sequence, so on a single-column page "next" simply means "next line down" —
 * but on a two-column page that rule reads straight across the gutter and
 * interleaves the columns into nonsense. So columns are detected first, and
 * lines are built within each column rather than across the page.
 */
function buildPage(positioned: PositionedItem[]): Line[] {
  if (positioned.length === 0) return [];

  const boundaries = detectColumnBoundaries(positioned);
  if (boundaries.length === 0) return buildLines(positioned);

  // A row whose ink runs continuously across a gutter is a banner — a title,
  // a full-width heading — and belongs to no single column. A row of ordinary
  // body text also has items either side of the gutter, but with the gutter
  // itself clear, which is what separates the two.
  const banners: PositionedItem[] = [];
  const columns: PositionedItem[][] = Array.from({ length: boundaries.length + 1 }, () => []);

  for (const row of groupRows(positioned)) {
    if (isBanner(row, boundaries)) banners.push(...row);
    else for (const item of row) columns[columnIndexFor(item, boundaries)].push(item);
  }

  const bannerLines = buildLines(banners);
  const columnLines = columns.map(buildLines);

  // Banners divide the page into horizontal bands. Within a band the columns
  // run left to right; the bands themselves run down the page. That ordering
  // is what keeps a full-width heading attached to the columns beneath it
  // rather than migrating to the top or bottom of the page.
  const out: Line[] = [];
  const emitted = columnLines.map(() => 0);

  const emitBandAbove = (limit: number) => {
    for (let column = 0; column < columnLines.length; column++) {
      const lines = columnLines[column];
      while (emitted[column] < lines.length && lines[emitted[column]].top > limit) {
        out.push(lines[emitted[column]++]);
      }
    }
  };

  for (const banner of bannerLines) {
    emitBandAbove(banner.top);
    out.push(banner);
  }
  emitBandAbove(-Infinity);

  return out;
}

/** How far an item must overhang a gutter before it counts as spanning it. */
const SPAN_TOLERANCE = 4;

/** Narrower than this is word spacing or a wide indent, not a gutter. */
const MIN_GUTTER_WIDTH = 8;

/**
 * How much of a page's ink a strip can carry and still be a gutter.
 *
 * Measured rather than guessed: on a two-column paper the gutter is crossed
 * by the title, the authors and the abstract — about a quarter of the page's
 * lines — while the body columns are covered by three quarters of them. The
 * threshold sits in that gap.
 */
const GUTTER_COVERAGE = 0.35;

/** Too few lines to read anything into the horizontal distribution. */
const MIN_LINES_FOR_COLUMNS = 12;

/** A column this thin is a margin note or a stray boundary, not a column. */
const MIN_COLUMN_LINES = 4;

/** Narrower than this holds no running text, whatever the whitespace says. */
const MIN_COLUMN_WIDTH = 60;

/**
 * Finds the x positions of column gutters, or an empty list for a page that
 * reads as one column.
 *
 * A gutter can't be defined as an *empty* strip: on a typical paper the title
 * and abstract run the full width and cross it, so nowhere on the page is
 * truly clear. What distinguishes it is how *rarely* it's crossed — body text
 * reaches every part of its own column and almost never the gutter. So this
 * counts, for each strip of the page, how many lines put ink there, and looks
 * for wide troughs.
 */
function detectColumnBoundaries(items: PositionedItem[]): number[] {
  const rows = buildLines(items);
  if (rows.length < MIN_LINES_FOR_COLUMNS) return [];

  const pageLeft = Math.min(...items.map((item) => item.x));
  const pageRight = Math.max(...items.map((item) => item.x + item.width));
  const width = pageRight - pageLeft;
  if (width <= 0) return [];

  // One bin per point of page width is finer than any gutter and cheap.
  const bins = Math.ceil(width);
  const coverage = new Uint32Array(bins);

  for (const item of items) {
    const from = Math.max(0, Math.floor(item.x - pageLeft));
    const to = Math.min(bins, Math.ceil(item.x + item.width - pageLeft));
    for (let bin = from; bin < to; bin++) coverage[bin]++;
  }

  const busiest = Math.max(...coverage);
  if (busiest === 0) return [];
  const threshold = busiest * GUTTER_COVERAGE;

  const boundaries: number[] = [];
  let runStart: number | null = null;

  for (let bin = 0; bin <= bins; bin++) {
    const isTrough = bin < bins && coverage[bin] <= threshold;
    if (isTrough) {
      if (runStart === null) runStart = bin;
      continue;
    }
    if (runStart !== null) {
      // Runs touching either edge are margins, not gutters.
      if (runStart > 0 && bin < bins && bin - runStart >= MIN_GUTTER_WIDTH) {
        boundaries.push(pageLeft + (runStart + bin) / 2);
      }
      runStart = null;
    }
  }

  const kept = dropNarrowColumns(boundaries, pageLeft, pageRight);
  return kept.length > 0 && producesRealColumns(items, kept) ? kept : [];
}

/**
 * Drops boundaries that would carve off a sliver. A page holding one figure
 * and a caption is mostly whitespace, and wide troughs open all over it
 * without any of them being a gutter.
 */
function dropNarrowColumns(boundaries: number[], pageLeft: number, pageRight: number): number[] {
  const kept: number[] = [];
  let edge = pageLeft;

  for (const boundary of boundaries) {
    if (boundary - edge < MIN_COLUMN_WIDTH) continue;
    kept.push(boundary);
    edge = boundary;
  }
  // The last column is bounded by the page rather than by another gutter.
  if (kept.length > 0 && pageRight - edge < MIN_COLUMN_WIDTH) kept.pop();
  return kept;
}

/**
 * Confirms every column actually holds lines of text, not just a stray item
 * or two that happened to fall on the far side of a boundary.
 */
function producesRealColumns(items: PositionedItem[], boundaries: number[]): boolean {
  const columns: PositionedItem[][] = Array.from({ length: boundaries.length + 1 }, () => []);
  for (const item of items) columns[columnIndexFor(item, boundaries)].push(item);
  return columns.every((column) => buildLines(column).length >= MIN_COLUMN_LINES);
}

/**
 * Whether a row's text runs across a gutter rather than sitting in a column.
 *
 * The test can't be applied to items as they come: pdf.js splits a line
 * wherever the font changes, so a full-width author credit arrives as a dozen
 * fragments broken at every superscript, none of which individually reaches
 * across the gutter. Adjacent fragments are stitched back together first, and
 * only the resulting continuous runs are measured.
 */
function isBanner(row: PositionedItem[], boundaries: number[]): boolean {
  let start = row[0].x;
  let end = row[0].x + row[0].width;

  const crossesGutter = () =>
    boundaries.some((boundary) => start < boundary - SPAN_TOLERANCE && end > boundary + SPAN_TOLERANCE);

  for (const item of row.slice(1)) {
    if (item.x - end >= MIN_GUTTER_WIDTH) {
      // A gap this wide breaks the run — anything before it stands alone.
      if (crossesGutter()) return true;
      start = item.x;
    }
    end = Math.max(end, item.x + item.width);
  }
  return crossesGutter();
}

function columnIndexFor(item: PositionedItem, boundaries: number[]): number {
  const middle = item.x + item.width / 2;
  const index = boundaries.findIndex((boundary) => middle < boundary);
  return index === -1 ? boundaries.length : index;
}

/**
 * Groups text items into lines by baseline.
 *
 * The tolerance is relative to glyph height rather than absolute: superscripts
 * and inline formula fragments sit slightly off the baseline and belong to the
 * same line, but a genuinely different line is always at least most of a line
 * height away.
 */
function buildLines(positioned: PositionedItem[]): Line[] {
  return groupRows(positioned)
    .map(toLine)
    .filter((line): line is Line => line !== null);
}

/** One row of items as a line, or null when it holds no visible text. */
function toLine(row: PositionedItem[]): Line | null {
  const text = joinRun(row);
  if (text.trim() === "") return null;
  return {
    text,
    size: Math.max(...row.map((item) => item.size)),
    top: row[0].y,
    left: row[0].x,
    right: Math.max(...row.map((item) => item.x + item.width)),
  };
}

/**
 * Items grouped by baseline, top of page first, each row ordered left to
 * right. Shared by line building and by column classification, which has to
 * reason about whole rows before any of them become text.
 */
function groupRows(positioned: PositionedItem[]): PositionedItem[][] {
  if (positioned.length === 0) return [];

  const sorted = [...positioned].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PositionedItem[][] = [];
  let current: PositionedItem[] = [];

  const flush = () => {
    if (current.length === 0) return;
    rows.push([...current].sort((a, b) => a.x - b.x));
    current = [];
  };

  for (const item of sorted) {
    if (current.length > 0) {
      const tolerance = Math.max(current[0].size, item.size) * 0.5;
      if (Math.abs(item.y - current[0].y) > tolerance) flush();
    }
    current.push(item);
  }
  flush();

  return rows;
}

/**
 * Joins the items on one line, inserting a space where the horizontal gap says
 * there was one. PDF writers split a line into runs wherever the font or
 * kerning changes, so the item boundaries themselves mean nothing.
 */
function joinRun(items: { text: string; x: number; width: number; size: number }[]): string {
  let out = items[0].text;
  let cursor = items[0].x + items[0].width;

  for (const item of items.slice(1)) {
    const gap = item.x - cursor;
    const needsSpace = gap > item.size * 0.2 && !/\s$/.test(out) && !/^\s/.test(item.text);
    out += needsSpace ? ` ${item.text}` : item.text;
    cursor = item.x + item.width;
  }
  return out;
}

/**
 * The most common glyph size, weighted by how much text is set at it — i.e.
 * the body size. Taking the mode rather than the mean keeps a document with a
 * big cover title or heavy footnote use from skewing the baseline.
 */
function modeFontSize(lines: Line[]): number {
  const weights = new Map<number, number>();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weights.set(key, (weights.get(key) ?? 0) + line.text.length);
  }

  let best = 0;
  let bestWeight = -1;
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      best = size;
      bestWeight = weight;
    }
  }
  return best || 12;
}

function medianLineWidth(lines: Line[]): number {
  const widths = lines.map((line) => line.right - line.left).sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)] ?? 0;
}

const BULLET_PATTERN = /^\s*([•·◦▪‣∙*+-]|•)\s+/;
const NUMBERED_PATTERN = /^\s*(\d{1,3})[.)]\s+/;

function renderPage(lines: Line[], bodySize: number, bodyWidth: number): string[] {
  const out: string[] = [];
  const headingLevels = headingLevelsFor(lines, bodySize);

  let block: { kind: "paragraph" | "item"; lines: string[]; left: number } | null = null;

  const flush = () => {
    if (!block) return;
    const text = squashSpaces(escapeInline(joinParagraphLines(block.lines)));
    if (text !== "") out.push(...(block.kind === "item" ? [bullet(0, text)] : ["", text, ""]));
    block = null;
  };

  // A line that stops well short of the right margin ends its block — it's
  // either the last line of the block or a standalone one. Wrapped body text
  // always runs to the margin, so this is a reliable break signal.
  const endsBlock = (line: Line) => line.right - line.left < bodyWidth * 0.85;

  lines.forEach((line, index) => {
    const level = headingLevels[index];
    if (level !== null) {
      flush();
      out.push("", heading(level, squashSpaces(escapeInline(line.text))), "");
      return;
    }

    const listMatch = BULLET_PATTERN.exec(line.text) ?? NUMBERED_PATTERN.exec(line.text);
    if (listMatch) {
      flush();
      block = { kind: "item", lines: [line.text.slice(listMatch[0].length)], left: line.left };
    } else if (block && continuesBlock(block, line, bodySize)) {
      // Continuation of whatever block is open — a wrapped list item stays
      // one item rather than becoming a bullet per visual line.
      block.lines.push(line.text);
    } else {
      flush();
      block = { kind: "paragraph", lines: [line.text], left: line.left };
    }

    if (endsBlock(line)) flush();
  });

  flush();
  return out;
}

/**
 * Whether a line continues the open block rather than starting a new one.
 *
 * Only list items get a real test: their wrapped lines sit indented past the
 * bullet (a hanging indent), so a line that starts back at the item's own
 * left edge is the next thing on the page, not more of the item. Without
 * this, a heading-less label sitting between a list and the next paragraph
 * gets swallowed into the last bullet.
 */
function continuesBlock(
  block: { kind: "paragraph" | "item"; left: number },
  line: Line,
  bodySize: number
): boolean {
  if (block.kind === "paragraph") return true;
  return line.left > block.left + bodySize * 0.4;
}

/**
 * Heading level per line, or null for body text.
 *
 * Size alone isn't enough: a page whose whole body is set one step larger
 * than the document's body size would come out as a wall of `###`. A real
 * heading is a *short run* of large lines — so a stretch of three or more
 * consecutive lines at the same larger size is read as body text set large,
 * not as a series of headings.
 */
function headingLevelsFor(lines: Line[], bodySize: number): (number | null)[] {
  const levels: (number | null)[] = lines.map((line) => {
    const ratio = line.size / bodySize;
    if (ratio < 1.2) return null;
    // A "heading" that runs on for a paragraph's worth of words is really
    // just large body text (pull quotes, cover blurbs).
    if (line.text.length > 120) return null;
    if (ratio >= 1.8) return 1;
    if (ratio >= 1.45) return 2;
    return 3;
  });

  for (let start = 0; start < lines.length; ) {
    if (levels[start] === null) {
      start++;
      continue;
    }
    let end = start;
    while (end + 1 < lines.length && levels[end + 1] !== null && lines[end + 1].size === lines[start].size) {
      end++;
    }
    if (end - start + 1 > 2) {
      for (let i = start; i <= end; i++) levels[i] = null;
    }
    start = end + 1;
  }

  return levels;
}

/**
 * Rejoins the lines of a paragraph, undoing the hyphenation that only existed
 * to fit the original column width.
 */
function joinParagraphLines(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    const text = line.trim();
    if (out === "") {
      out = text;
    } else if (/[‐-]$/.test(out)) {
      out = `${out.slice(0, -1)}${text}`;
    } else {
      out = `${out} ${text}`;
    }
  }
  return out;
}
