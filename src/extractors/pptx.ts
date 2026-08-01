import { ZipArchive } from "../zip";
import {
  children,
  descendants,
  imageRelationshipIds,
  parseXml,
  readRelationships,
  Relationship,
  resolvePartPath,
  saveImages,
} from "../ooxml";
import { AssetSink, droppedImagesWarning } from "../assets";
import { bullet, escapeInline, heading, joinBlocks, squashSpaces, table } from "../markdown";
import { ExtractResult } from "./types";

const PRESENTATION_PART = "ppt/presentation.xml";
const SLIDE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const NOTES_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide";

/**
 * .pptx → Markdown, one `##` section per slide.
 *
 * This is the format with no good turnkey converter, and the one where a
 * generalist tool has the least to go on: a deck is a bag of positioned
 * shapes, not a document flow. What makes the output readable is using the
 * *placeholder* metadata PowerPoint already records — a shape tagged as the
 * title placeholder becomes the slide heading, body placeholders become
 * bullets at their own indent level — instead of guessing from geometry.
 */
export async function extractPptx(data: Buffer, assets: AssetSink): Promise<ExtractResult> {
  const zip = ZipArchive.open(data);
  if (!zip.has(PRESENTATION_PART)) throw new Error("not a PowerPoint presentation (no ppt/presentation.xml)");

  const slidePaths = readSlideOrder(zip);
  if (slidePaths.length === 0) throw new Error("presentation contains no slides");

  const context: PptxContext = { droppedImages: 0, droppedCharts: 0 };
  const lines: string[] = [];

  for (const [index, slidePath] of slidePaths.entries()) {
    lines.push(...(await renderSlide(zip, slidePath, index + 1, context, assets)));
  }

  const warnings: string[] = [];
  if (context.droppedImages > 0) warnings.push(droppedImagesWarning(context.droppedImages, assets.enabled));
  if (context.droppedCharts > 0) {
    warnings.push(
      `${context.droppedCharts} chart${context.droppedCharts === 1 ? "" : "s"} or embedded object${context.droppedCharts === 1 ? " was" : "s were"} skipped.`
    );
  }

  return { markdown: joinBlocks(lines), warnings };
}

interface PptxContext {
  droppedImages: number;
  droppedCharts: number;
}

/**
 * Slides in presentation order. The `ppt/slides/` directory listing is *not*
 * the running order — slideN.xml numbering reflects creation order, and
 * reordering or deleting slides leaves it scrambled. `p:sldIdLst` is the
 * authoritative sequence.
 */
function readSlideOrder(zip: ZipArchive): string[] {
  const xml = zip.text(PRESENTATION_PART);
  if (!xml) return [];

  const rels = readRelationships(zip, PRESENTATION_PART);
  const paths: string[] = [];

  for (const slideId of descendants(parseXml(xml), "p:sldId")) {
    const id = slideId.getAttribute("r:id");
    if (!id) continue;
    const rel = rels.get(id);
    if (!rel || rel.external || rel.type !== SLIDE_REL_TYPE) continue;
    paths.push(resolvePartPath(PRESENTATION_PART, rel.target));
  }
  return paths;
}

async function renderSlide(
  zip: ZipArchive,
  slidePath: string,
  slideNumber: number,
  context: PptxContext,
  assets: AssetSink
): Promise<string[]> {
  const xml = zip.text(slidePath);
  if (!xml) return [];

  const shapeTree = parseXml(xml).getElementsByTagName("p:spTree").item(0);
  if (!shapeTree) return [];

  const rels = readRelationships(zip, slidePath);
  const images = await saveImages(zip, slidePath, rels, imageRelationshipIds(shapeTree), assets);
  const blocks: string[] = [];
  let title: string | null = null;

  for (const shape of walkShapes(shapeTree)) {
    if (shape.tagName === "p:pic") {
      const embed = imageRelationshipIds(shape)
        .map((id) => images.get(id))
        .find((found) => found !== undefined);
      if (embed) blocks.push("", embed, "");
      else context.droppedImages++;
      continue;
    }
    if (shape.tagName === "p:graphicFrame") {
      const tableElement = shape.getElementsByTagName("a:tbl").item(0);
      if (tableElement) blocks.push("", ...renderTable(tableElement, rels), "");
      else context.droppedCharts++;
      continue;
    }

    const body = children(shape, "p:txBody")[0];
    if (!body) continue;

    // The first title placeholder becomes the slide heading; a deck with two
    // title-ish shapes still only gets one heading, and the rest read as body.
    if (title === null && isTitlePlaceholder(shape)) {
      // Title placeholders are almost always bold by design; carrying that
      // into the heading would render as `## **Title**`.
      title = squashSpaces(children(body, "a:p").map((p) => renderParagraphText(p, rels, true)).join(" "));
      if (title !== "") continue;
      title = null;
    }

    blocks.push(...renderTextBody(body, rels, shouldRenderAsList(shape, body)));
  }

  const header = title ? `Slide ${slideNumber}: ${title}` : `Slide ${slideNumber}`;
  const notes = renderNotes(zip, slidePath, rels);

  return ["", heading(2, header), "", ...blocks, ...notes, ""];
}

/** Shapes in document order, flattening groups (which can nest arbitrarily). */
function* walkShapes(parent: Element): Generator<Element> {
  for (const node of Array.from(parent.children)) {
    if (node.tagName === "p:grpSp") {
      yield* walkShapes(node);
    } else if (node.tagName === "p:sp" || node.tagName === "p:pic" || node.tagName === "p:graphicFrame") {
      yield node;
    }
  }
}

function isTitlePlaceholder(shape: Element): boolean {
  const placeholder = shape.getElementsByTagName("p:ph").item(0);
  const type = placeholder?.getAttribute("type");
  return type === "title" || type === "ctrTitle";
}

function renderTextBody(body: Element, rels: Map<string, Relationship>, asList: boolean): string[] {
  const lines: string[] = [];

  for (const paragraph of children(body, "a:p")) {
    const text = renderParagraphText(paragraph, rels);
    if (text === "") continue;

    const properties = children(paragraph, "a:pPr")[0] ?? null;
    const depth = Number(properties?.getAttribute("lvl") ?? "0");

    // `a:buNone` is how PowerPoint marks a paragraph that opts out of its
    // placeholder's bullets — subtitles and callout text usually do.
    const bulleted = asList && !(properties && children(properties, "a:buNone").length > 0);

    if (bulleted) lines.push(bullet(Number.isFinite(depth) ? depth : 0, text));
    else lines.push("", text, "");
  }

  return lines;
}

/**
 * Whether a shape's text should read as a list.
 *
 * A deck is full of loose text boxes — kickers, dates, footnotes, section
 * labels — that carry no bullet in the deck itself. Rendering every one of
 * them as a `-` item is what makes a naive PPTX conversion look like an
 * outline of nonsense. Bullets are used for the two cases that really are
 * lists: a body placeholder (which PowerPoint bullets by default), and any
 * text box holding more than one paragraph.
 */
function shouldRenderAsList(shape: Element, body: Element): boolean {
  const type = shape.getElementsByTagName("p:ph").item(0)?.getAttribute("type");
  if (type === "body" || type === "subTitle") return true;
  return children(body, "a:p").length > 1;
}

function renderParagraphText(paragraph: Element, rels: Map<string, Relationship>, plain = false): string {
  let out = "";

  for (const node of Array.from(paragraph.children)) {
    switch (node.tagName) {
      case "a:r":
        out += renderRun(node, rels, plain);
        break;
      case "a:fld":
        // Auto-fields (slide numbers, dates) carry their last-rendered value
        // in a plain `a:t`, which is the only value available offline.
        out += escapeInline(node.getElementsByTagName("a:t").item(0)?.textContent ?? "");
        break;
      case "a:br":
        out += " ";
        break;
    }
  }

  return squashSpaces(out);
}

function renderRun(run: Element, rels: Map<string, Relationship>, plain: boolean): string {
  const text = run.getElementsByTagName("a:t").item(0)?.textContent ?? "";
  if (text.trim() === "") return text;

  const properties = children(run, "a:rPr")[0] ?? null;
  let rendered = escapeInline(text);

  if (!plain) {
    const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(rendered) as RegExpExecArray;
    let wrapped = core;
    if (properties?.getAttribute("i") === "1") wrapped = `*${wrapped}*`;
    if (properties?.getAttribute("b") === "1") wrapped = `**${wrapped}**`;
    rendered = `${leading}${wrapped}${trailing}`;
  }

  const linkId = properties?.getElementsByTagName("a:hlinkClick").item(0)?.getAttribute("r:id");
  const target = linkId ? rels.get(linkId)?.target : undefined;
  return target ? `[${rendered}](${target})` : rendered;
}

function renderTable(tableElement: Element, rels: Map<string, Relationship>): string[] {
  const rows: string[][] = [];

  for (const row of children(tableElement, "a:tr")) {
    const cells = children(row, "a:tc").map((cell) => {
      const body = children(cell, "a:txBody")[0];
      if (!body) return "";
      return children(body, "a:p")
        .map((paragraph) => renderParagraphText(paragraph, rels))
        .filter((text) => text !== "")
        .join("\n");
    });
    if (cells.length > 0) rows.push(cells);
  }

  return table(rows);
}

function renderNotes(zip: ZipArchive, slidePath: string, rels: Map<string, Relationship>): string[] {
  const notesRel = [...rels.values()].find((rel) => rel.type === NOTES_REL_TYPE && !rel.external);
  if (!notesRel) return [];

  const notesPath = resolvePartPath(slidePath, notesRel.target);
  const xml = zip.text(notesPath);
  if (!xml) return [];

  const notesRels = readRelationships(zip, notesPath);
  const lines: string[] = [];

  for (const shape of descendants(parseXml(xml), "p:sp")) {
    // The notes slide also contains a thumbnail of the slide itself and a
    // slide-number field; only the body placeholder holds the actual notes.
    const type = shape.getElementsByTagName("p:ph").item(0)?.getAttribute("type");
    if (type !== "body") continue;

    const body = children(shape, "p:txBody")[0];
    if (!body) continue;

    for (const paragraph of children(body, "a:p")) {
      const text = renderParagraphText(paragraph, notesRels);
      if (text !== "") lines.push(text, "");
    }
  }

  if (lines.length === 0) return [];
  return ["", heading(3, "Notes"), "", ...lines];
}
