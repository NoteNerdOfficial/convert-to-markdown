import { ZipArchive } from "../zip";
import { children, descendants, firstDescendant, parseXml, readRelationships, Relationship } from "../ooxml";
import { bullet, escapeInline, heading, joinBlocks, numbered, squashSpaces, table } from "../markdown";
import { ExtractResult } from "./types";

const DOCUMENT_PART = "word/document.xml";
const NUMBERING_PART = "word/numbering.xml";

/**
 * .docx → Markdown by walking the document body in order.
 *
 * Word's model maps onto Markdown more directly than any other format here:
 * the body is a flat sequence of paragraphs and tables, and a paragraph
 * already carries its own semantics (heading level, list level) in `w:pPr`.
 * The job is mostly reading those out rather than inferring anything.
 */
export async function extractDocx(data: Buffer): Promise<ExtractResult> {
  const zip = ZipArchive.open(data);
  const documentXml = zip.text(DOCUMENT_PART);
  if (!documentXml) throw new Error("not a Word document (no word/document.xml)");

  const doc = parseXml(documentXml);
  const body = doc.getElementsByTagName("w:body").item(0);
  if (!body) throw new Error("Word document has no body");

  const context: DocxContext = {
    rels: readRelationships(zip, DOCUMENT_PART),
    numbering: readNumbering(zip),
    droppedImages: 0,
  };

  const lines: string[] = [];
  for (const node of Array.from(body.children)) {
    if (node.tagName === "w:p") {
      lines.push(...renderParagraph(node, context));
    } else if (node.tagName === "w:tbl") {
      lines.push("", ...renderTable(node, context), "");
    }
  }

  const warnings: string[] = [];
  if (context.droppedImages > 0) {
    warnings.push(
      context.droppedImages === 1
        ? "1 embedded image was not extracted (text only)."
        : `${context.droppedImages} embedded images were not extracted (text only).`
    );
  }

  return { markdown: joinBlocks(lines), warnings };
}

interface DocxContext {
  rels: Map<string, Relationship>;
  numbering: NumberingIndex;
  droppedImages: number;
}

function renderParagraph(paragraph: Element, context: DocxContext): string[] {
  const properties = children(paragraph, "w:pPr")[0] ?? null;
  const text = renderRuns(paragraph, context);
  if (text.trim() === "") return [""];

  const level = headingLevel(properties);
  if (level !== null) return ["", heading(level, text), ""];

  const list = listPosition(properties, context.numbering);
  if (list) return [list.ordered ? numbered(list.depth, text) : bullet(list.depth, text)];

  return ["", text, ""];
}

/**
 * Heading level from the paragraph style. Word writes built-in headings as
 * `Heading1`…`Heading9` (or localised aliases that still keep the digit), and
 * Title/Subtitle as their own styles rather than as heading levels.
 */
function headingLevel(properties: Element | null): number | null {
  if (!properties) return null;
  const style = children(properties, "w:pStyle")[0]?.getAttribute("w:val");
  if (!style) return null;

  if (/^title$/i.test(style)) return 1;
  if (/^subtitle$/i.test(style)) return 2;

  const match = /^heading\s*(\d)$/i.exec(style);
  return match ? Number(match[1]) : null;
}

interface ListPosition {
  depth: number;
  ordered: boolean;
}

function listPosition(properties: Element | null, numbering: NumberingIndex): ListPosition | null {
  if (!properties) return null;
  const numberingProperties = children(properties, "w:numPr")[0];
  if (!numberingProperties) return null;

  const numId = children(numberingProperties, "w:numId")[0]?.getAttribute("w:val");
  const depth = Number(children(numberingProperties, "w:ilvl")[0]?.getAttribute("w:val") ?? "0");
  if (!numId) return null;

  // numId 0 means "this paragraph explicitly has no numbering" in OOXML.
  if (numId === "0") return null;

  return { depth: Number.isFinite(depth) ? depth : 0, ordered: numbering.isOrdered(numId, depth) };
}

/**
 * Renders the inline content of a paragraph: text runs, their bold/italic
 * formatting, hyperlinks, and line breaks.
 */
function renderRuns(container: Element, context: DocxContext): string {
  let out = "";

  for (const node of Array.from(container.children)) {
    if (node.tagName === "w:pPr") continue;

    if (node.tagName === "w:hyperlink") {
      const inner = renderRuns(node, context);
      const target = hyperlinkTarget(node, context.rels);
      out += target ? `[${inner}](${target})` : inner;
      continue;
    }

    if (node.tagName === "w:r") {
      out += renderRun(node, context);
      continue;
    }

    // Tracked-change wrappers (w:ins) and smart-tag wrappers hold runs a level
    // deeper; recursing keeps their text rather than silently dropping it.
    // Deletions (w:del) hold `w:delText`, which is text that isn't there any
    // more — skipping the element skips those.
    if (node.tagName === "w:ins" || node.tagName === "w:smartTag" || node.tagName === "w:sdt") {
      out += renderRuns(node, context);
    }
  }

  return squashSpaces(out);
}

function renderRun(run: Element, context: DocxContext): string {
  const properties = children(run, "w:rPr")[0] ?? null;
  let text = "";

  for (const node of Array.from(run.children)) {
    switch (node.tagName) {
      case "w:t":
        text += node.textContent ?? "";
        break;
      case "w:tab":
        text += " ";
        break;
      case "w:br":
        text += "\n";
        break;
      case "w:drawing":
      case "w:pict":
        context.droppedImages++;
        break;
    }
  }

  if (text === "") return "";

  // Escape before wrapping in emphasis markers, so the markers survive.
  text = escapeInline(text);

  // Leading/trailing spaces have to sit outside the emphasis markers —
  // `** bold **` doesn't render as bold in any Markdown flavour.
  const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
  if (core === "") return text;

  let wrapped = core;
  if (isEnabled(properties, "w:i")) wrapped = `*${wrapped}*`;
  if (isEnabled(properties, "w:b")) wrapped = `**${wrapped}**`;
  return `${leading}${wrapped}${trailing}`;
}

/**
 * OOXML toggle properties are present-means-on, except that an explicit
 * `w:val="0"`/`"false"` turns them back off (used when a style enables them).
 */
function isEnabled(properties: Element | null, tagName: string): boolean {
  if (!properties) return false;
  const toggle = children(properties, tagName)[0];
  if (!toggle) return false;
  const value = toggle.getAttribute("w:val");
  return value !== "0" && value !== "false" && value !== "off";
}

function hyperlinkTarget(link: Element, rels: Map<string, Relationship>): string | null {
  const id = link.getAttribute("r:id");
  if (id) {
    const rel = rels.get(id);
    if (rel) return rel.target;
  }
  const anchor = link.getAttribute("w:anchor");
  return anchor ? `#${anchor}` : null;
}

function renderTable(tableElement: Element, context: DocxContext): string[] {
  const rows: string[][] = [];

  for (const row of children(tableElement, "w:tr")) {
    const cells: string[] = [];
    for (const cell of children(row, "w:tc")) {
      const paragraphs = children(cell, "w:p").map((p) => renderRuns(p, context));
      cells.push(paragraphs.filter((text) => text !== "").join("\n"));
    }
    if (cells.length > 0) rows.push(cells);
  }

  return table(rows);
}

/**
 * Whether a given (numId, level) is an ordered list. Word stores that two
 * hops away: `w:num` maps a numId to an abstract numbering definition, and
 * the definition's level carries the `w:numFmt` ("bullet" or a number format).
 */
interface NumberingIndex {
  isOrdered(numId: string, level: number): boolean;
}

function readNumbering(zip: ZipArchive): NumberingIndex {
  const xml = zip.text(NUMBERING_PART);
  if (!xml) return { isOrdered: () => false };

  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    return { isOrdered: () => false };
  }

  const numIdToAbstract = new Map<string, string>();
  for (const num of descendants(doc, "w:num")) {
    const numId = num.getAttribute("w:numId");
    const abstractId = firstDescendant(num, "w:abstractNumId")?.getAttribute("w:val");
    if (numId && abstractId) numIdToAbstract.set(numId, abstractId);
  }

  const formats = new Map<string, string>();
  for (const abstractNum of descendants(doc, "w:abstractNum")) {
    const abstractId = abstractNum.getAttribute("w:abstractNumId");
    if (!abstractId) continue;
    for (const level of children(abstractNum, "w:lvl")) {
      const index = level.getAttribute("w:ilvl") ?? "0";
      const format = children(level, "w:numFmt")[0]?.getAttribute("w:val");
      if (format) formats.set(`${abstractId}:${index}`, format);
    }
  }

  return {
    isOrdered(numId, level) {
      const abstractId = numIdToAbstract.get(numId);
      if (!abstractId) return false;
      const format = formats.get(`${abstractId}:${level}`);
      return format !== undefined && format !== "bullet" && format !== "none";
    },
  };
}
