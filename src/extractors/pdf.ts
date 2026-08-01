import * as pdfjsLib from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";
import { bullet, escapeInline, heading, joinBlocks, squashSpaces } from "../markdown";
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
 * The one thing geometry can't do is read a scan. A PDF that is just page
 * images has no text layer at all, and that case is reported rather than
 * silently returning an empty note.
 */
export async function extractPdf(data: Buffer): Promise<ExtractResult> {
  ensureWorker();

  // pdf.js takes ownership of the buffer it's handed, so pass a copy — the
  // caller's Buffer would otherwise come back detached.
  const document = await pdfjsLib.getDocument({ data: new Uint8Array(data) }).promise;

  try {
    const pages: Line[][] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        pages.push(buildLines(content.items.filter(isTextItem)));
      } finally {
        page.cleanup();
      }
    }

    const allLines = pages.flat();
    if (allLines.length === 0) {
      throw new Error(
        "this PDF has no text layer — it's a scan or an image-only export, which needs OCR rather than extraction"
      );
    }

    const bodySize = modeFontSize(allLines);
    const bodyWidth = medianLineWidth(allLines);
    const isRunningHeader = detectRunningHeaders(pages);

    const lines: string[] = [];
    for (const pageLines of pages) {
      lines.push(...renderPage(pageLines.filter((line) => !isRunningHeader(line)), bodySize, bodyWidth));
    }

    return { markdown: joinBlocks(lines), warnings: pdfWarnings(document.numPages, pages) };
  } finally {
    await document.destroy();
  }
}

function pdfWarnings(pageCount: number, pages: Line[][]): string[] {
  const blankPages = pages.filter((page) => page.length === 0).length;
  const warnings = ["Images, figures and vector graphics are not extracted."];
  if (blankPages > 0) {
    warnings.push(
      `${blankPages} of ${pageCount} pages had no text layer (likely scanned) and produced nothing.`
    );
  }
  return warnings;
}

/**
 * Identifies running headers and footers so they don't land in the note once
 * per page. A PDF has no marker for them — they're just the first and last
 * lines of every page — so they're found by repetition: the same line, page
 * after page, ignoring the page number that changes.
 */
function detectRunningHeaders(pages: Line[][]): (line: Line) => boolean {
  const EDGE_LINES = 2;
  const counts = new Map<string, number>();

  const edgesOf = (page: Line[]) => [...page.slice(0, EDGE_LINES), ...page.slice(-EDGE_LINES)];
  const normalize = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();

  for (const page of pages) {
    // Count each distinct line once per page, so a page that happens to
    // repeat a phrase twice doesn't vote twice.
    for (const key of new Set(edgesOf(page).map((line) => normalize(line.text)))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // Needs to appear on most pages *and* on enough pages for the repetition to
  // mean anything — a 3-page document has no reliable signal here.
  const threshold = Math.max(4, Math.ceil(pages.length * 0.5));
  const repeated = new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
  if (repeated.size === 0) return () => false;

  const edgeLines = new Set(pages.flatMap(edgesOf));
  return (line) => edgeLines.has(line) && repeated.has(normalize(line.text));
}

function isTextItem(item: unknown): item is TextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

interface Line {
  text: string;
  /** Largest glyph height on the line — what makes a heading look like one. */
  size: number;
  /** Left edge in PDF user space, used to detect indented blocks. */
  left: number;
  right: number;
}

/**
 * Groups text items into lines by baseline.
 *
 * The tolerance is relative to glyph height rather than absolute: superscripts
 * and inline formula fragments sit slightly off the baseline and belong to the
 * same line, but a genuinely different line is always at least most of a line
 * height away.
 */
function buildLines(items: TextItem[]): Line[] {
  const positioned = items
    .filter((item) => item.str !== "")
    .map((item) => ({
      text: item.str,
      x: item.transform[4] as number,
      y: item.transform[5] as number,
      width: item.width,
      size: Math.abs(item.transform[3] as number) || item.height,
    }));

  if (positioned.length === 0) return [];

  positioned.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: Line[] = [];
  let current: typeof positioned = [];

  const flush = () => {
    if (current.length === 0) return;
    current.sort((a, b) => a.x - b.x);
    const size = Math.max(...current.map((item) => item.size));
    const text = joinRun(current);
    if (text.trim() !== "") {
      lines.push({
        text,
        size,
        left: current[0].x,
        right: Math.max(...current.map((item) => item.x + item.width)),
      });
    }
    current = [];
  };

  for (const item of positioned) {
    if (current.length > 0) {
      const tolerance = Math.max(current[0].size, item.size) * 0.5;
      if (Math.abs(item.y - current[0].y) > tolerance) flush();
    }
    current.push(item);
  }
  flush();

  return lines;
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
