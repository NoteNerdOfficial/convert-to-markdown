import { AssetSink, droppedImagesWarning, imageExtensionForMime, imageExtensionOf } from "../assets";
import { bullet, escapeInline, heading, joinBlocks, numbered, squashSpaces, table, yamlValue } from "../markdown";
import { children, descendants, parseXml } from "../ooxml";
import { ZipArchive } from "../zip";
import { ExtractOptions, ExtractResult } from "./types";

const CONTENT = "content.xml";
const STYLES = "styles.xml";
const META = "meta.xml";

/**
 * .odt / .ods / .odp → Markdown.
 *
 * OpenDocument is the same idea as OOXML — zipped XML, one part per concern —
 * arrived at by a different committee, and the differences are the interesting
 * part. Two of them shape this reader.
 *
 * A heading states its own level (`text:outline-level`) instead of naming a
 * style that has one, so heading structure is read rather than inferred. And a
 * spreadsheet cell stores its *displayed* text next to its raw value, which
 * means the elaborate number-format machinery the .xlsx reader needs — parsing
 * format codes to recover `27.38` from `27.383982300884924`, scaling
 * percentages — is unnecessary here: LibreOffice already wrote down what it
 * showed on screen.
 *
 * One extractor serves all three document types because the file says which it
 * is. The extension is a hint, `office:body` is the fact, and a spreadsheet
 * mistakenly saved as `.odt` still converts as a spreadsheet.
 */
export async function extractOpenDocument(
  data: Buffer,
  assets: AssetSink,
  _ocr: unknown,
  options: ExtractOptions
): Promise<ExtractResult> {
  const zip = ZipArchive.open(data);
  const contentXml = zip.text(CONTENT);
  if (!contentXml) throw new Error("not an OpenDocument file (no content.xml)");

  const content = parseXml(contentXml);
  const body = descendants(content, "office:body")[0];
  if (!body) throw new Error("this OpenDocument file has no body");

  const context: OdfContext = {
    textStyles: readTextStyles(zip, content),
    listStyles: readListStyles(zip, content),
    hiddenTables: readHiddenTables(zip, content),
    images: await saveImages(zip, content, assets),
    assets,
    droppedImages: 0,
    footnotes: [],
    skippedIndexes: [],
  };

  const text = children(body, "office:text")[0];
  const sheet = children(body, "office:spreadsheet")[0];
  const deck = children(body, "office:presentation")[0];
  const drawing = children(body, "office:drawing")[0];

  const result = sheet
    ? renderSpreadsheet(sheet, context, options)
    : deck
      ? renderPresentation(deck, context)
      : renderTextDocument(text ?? drawing ?? body, context);

  const warnings = [...result.warnings];
  if (context.droppedImages > 0) warnings.push(droppedImagesWarning(context.droppedImages, assets.enabled));
  if (context.skippedIndexes.length > 0) {
    warnings.push(
      `${context.skippedIndexes.length} generated index${context.skippedIndexes.length === 1 ? "" : "es"} left out ` +
        `(${context.skippedIndexes.join(", ")}) — a table of contents or bibliography that the word processor ` +
        "rebuilds from the document, so it lists page numbers this note doesn't have."
    );
  }

  const lines = [...result.lines];
  if (context.footnotes.length > 0) {
    lines.push("", "---", "");
    for (const [index, note] of context.footnotes.entries()) {
      lines.push(`[^${index + 1}]: ${note}`);
    }
  }

  return {
    markdown: joinBlocks(lines),
    warnings,
    frontmatter: { ...readMetadata(zip), ...result.frontmatter },
  };
}

interface OdfContext {
  /** Bold/italic per text style name, from the document's automatic styles. */
  textStyles: Map<string, { bold: boolean; italic: boolean }>;
  /** Whether a given list style numbers its items, per level. */
  listStyles: Map<string, Map<number, boolean>>;
  /** Table style names that LibreOffice marks as not displayed. */
  hiddenTables: Set<string>;
  /** Markdown embed per `draw:image` element that was saved. */
  images: Map<Element, string>;
  assets: AssetSink;
  droppedImages: number;
  /** Footnote and endnote bodies, in the order they were referenced. */
  footnotes: string[];
  skippedIndexes: string[];
}

interface Rendered {
  lines: string[];
  warnings: string[];
  frontmatter: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Text documents
// ---------------------------------------------------------------------------

function renderTextDocument(body: Element, context: OdfContext): Rendered {
  return { lines: renderFlow(body, context), warnings: [], frontmatter: {} };
}

/**
 * Walks a run of block-level content — the body of a document, a table cell, a
 * text box on a slide. All three hold the same elements, so all three are read
 * by the same walk.
 */
function renderFlow(container: Element, context: OdfContext): string[] {
  const lines: string[] = [];

  for (const node of Array.from(container.children)) {
    switch (node.tagName) {
      case "text:h": {
        const text = renderInline(node, context);
        if (text.trim() === "") break;
        const level = Number(node.getAttribute("text:outline-level") ?? "1");
        lines.push("", heading(Number.isFinite(level) && level > 0 ? level : 1, text), "");
        break;
      }

      case "text:p": {
        const text = renderInline(node, context);
        if (text.trim() !== "") lines.push("", text, "");
        break;
      }

      case "text:list":
        lines.push("", ...renderList(node, context, 0, null), "");
        break;

      case "table:table":
        lines.push("", ...renderTable(node, context), "");
        break;

      // A generated contents page or bibliography. Its body is a snapshot of
      // headings with page numbers, which is exactly the part that means
      // nothing in a note.
      case "text:table-of-content":
      case "text:illustration-index":
      case "text:table-index":
      case "text:object-index":
      case "text:user-index":
      case "text:alphabetical-index":
      case "text:bibliography":
        context.skippedIndexes.push(node.getAttribute("text:name") ?? node.tagName.replace("text:", ""));
        break;

      case "text:section":
      case "office:text":
      case "text:index-body":
        lines.push(...renderFlow(node, context));
        break;

      // A text box holds flowing content directly; a frame or shape wraps it,
      // and may wrap an image instead.
      case "draw:text-box":
        lines.push("", ...renderFlow(node, context), "");
        break;

      case "draw:frame":
      case "draw:custom-shape":
      case "draw:g": {
        const rendered = renderFrame(node, context);
        if (rendered.length > 0) lines.push("", ...rendered, "");
        break;
      }

      // Tracked changes hold the text that *was* there before an edit; the
      // current text is in the document proper.
      case "text:tracked-changes":
      case "text:sequence-decls":
      case "office:forms":
      case "text:soft-page-break":
        break;

      default:
        // Unknown wrappers are transparent rather than fatal: ODF grows new
        // container elements, and dropping a subtree because its wrapper is
        // unfamiliar loses text that renders perfectly well.
        if (node.children.length > 0) lines.push(...renderFlow(node, context));
    }
  }

  return lines;
}

/**
 * A drawing frame, which is how ODF attaches anything that isn't flowing text
 * — an image, a text box, a chart. A frame can hold several alternatives (an
 * image plus a fallback), so the first one that produces something wins.
 */
function renderFrame(frame: Element, context: OdfContext): string[] {
  // The frame may itself be the text box — a slide's title placeholder is
  // often written without the intervening wrapper.
  if (frame.tagName === "draw:text-box") return renderFlow(frame, context);

  const image = descendants(frame, "draw:image")[0];
  if (image) {
    const embed = context.images.get(image);
    if (embed) {
      const caption = squashSpaces(descendants(frame, "svg:title")[0]?.textContent ?? "");
      return caption === "" ? [embed] : [embed, `*${escapeInline(caption)}*`];
    }
    context.droppedImages++;
    return [];
  }

  const textBox = descendants(frame, "draw:text-box")[0];
  if (textBox) return renderFlow(textBox, context);

  // A chart or an embedded spreadsheet. It's a data structure, not a picture,
  // and there's nothing to embed — the same call the deck extractor makes.
  return [];
}

function renderList(list: Element, context: OdfContext, depth: number, inheritedStyle: string | null): string[] {
  const styleName = list.getAttribute("text:style-name") ?? inheritedStyle;
  const ordered = styleName ? (context.listStyles.get(styleName)?.get(depth + 1) ?? false) : false;
  const lines: string[] = [];

  for (const item of Array.from(list.children)) {
    if (item.tagName !== "text:list-item" && item.tagName !== "text:list-header") continue;

    let first = true;
    for (const node of Array.from(item.children)) {
      if (node.tagName === "text:list") {
        lines.push(...renderList(node, context, depth + 1, styleName));
        continue;
      }
      const text = renderInline(node, context);
      if (text.trim() === "") continue;
      // Only the first paragraph gets the marker; a second paragraph in the
      // same item is continuation text indented under it.
      if (first) {
        lines.push(ordered ? numbered(depth, text) : bullet(depth, text));
        first = false;
      } else {
        lines.push(`${"  ".repeat(depth + 1)}${text}`);
      }
    }
  }

  return lines;
}

function renderTable(tableElement: Element, context: OdfContext): string[] {
  const rows: string[][] = [];

  for (const row of tableRows(tableElement)) {
    const cells = readRowCells(row, (cell) => renderCell(cell, context));
    if (cells.length > 0) rows.push(cells);
  }

  return table(trimEmptyRows(rows));
}

function renderCell(cell: Element, context: OdfContext): string {
  const lines = renderFlow(cell, context).filter((line) => line.trim() !== "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Spreadsheets
// ---------------------------------------------------------------------------

function renderSpreadsheet(sheet: Element, context: OdfContext, options: ExtractOptions): Rendered {
  const tables = children(sheet, "table:table");
  const lines: string[] = [];
  const warnings: string[] = [];
  const skipped: string[] = [];
  let converted = 0;

  for (const sheetTable of tables) {
    const name = sheetTable.getAttribute("table:name") ?? `Sheet ${converted + 1}`;
    const styleName = sheetTable.getAttribute("table:style-name") ?? "";
    const hidden = context.hiddenTables.has(styleName);

    if (hidden && !options.includeHiddenSheets) {
      skipped.push(name);
      continue;
    }

    const rows = trimEmptyRows(
      tableRows(sheetTable).map((row) => readRowCells(row, (cell) => renderSheetCell(cell, context)))
    );

    lines.push("", heading(2, escapeInline(name)), "");
    if (rows.length === 0) lines.push("*(empty sheet)*", "");
    else lines.push(...table(rows), "");
    converted++;
  }

  if (skipped.length > 0) {
    warnings.push(`Skipped (hidden): ${skipped.join(", ")}.`);
  }

  return {
    lines,
    warnings,
    frontmatter: { sheets_converted: `${converted}/${tables.length}` },
  };
}

/**
 * A spreadsheet cell's text.
 *
 * The `text:p` inside a cell is what LibreOffice displayed — the number with
 * its format already applied — while `office:value` is the full-precision
 * figure behind it. Preferring the displayed text is what gives `27.38%` and
 * `15 March 2024` rather than `0.2738` and `45366`, and it costs nothing,
 * because the raw value is still there when a cell has no display text at all.
 */
function renderSheetCell(cell: Element, context: OdfContext): string {
  const displayed = children(cell, "text:p")
    .map((paragraph) => renderInline(paragraph, context))
    .filter((text) => text.trim() !== "")
    .join("\n");
  if (displayed !== "") return displayed;

  for (const attribute of ["office:date-value", "office:time-value", "office:value", "office:boolean-value"]) {
    const value = cell.getAttribute(attribute);
    if (value) return escapeInline(value);
  }

  // A cell holding only a frame — an image floating over the grid.
  const frames = children(cell, "draw:frame").flatMap((frame) => renderFrame(frame, context));
  return frames.join(" ");
}

// ---------------------------------------------------------------------------
// Presentations
// ---------------------------------------------------------------------------

function renderPresentation(deck: Element, context: OdfContext): Rendered {
  const pages = children(deck, "draw:page");
  const lines: string[] = [];

  for (const [index, page] of pages.entries()) {
    const frames = Array.from(page.children).filter((node) => node.tagName.startsWith("draw:"));
    const titleFrame = frames.find((frame) => isTitle(frame));

    const title = titleFrame ? squashSpaces(renderFrame(titleFrame, context).join(" ")) : "";
    lines.push("", heading(2, title === "" ? `Slide ${index + 1}` : title), "");

    for (const frame of frames) {
      if (frame === titleFrame) continue;
      const rendered = renderFrame(frame, context);
      if (rendered.length > 0) lines.push(...rendered, "");
    }

    // Speaker notes are the half of a deck that says what the slide means, and
    // they are stored right here rather than in a separate part.
    const notes = children(page, "presentation:notes")[0];
    if (notes) {
      const noteLines = renderFlow(notes, context).filter((line) => line.trim() !== "");
      if (noteLines.length > 0) {
        lines.push("", "> [!note]- Speaker notes", ...noteLines.map((line) => `> ${line}`), "");
      }
    }
  }

  return { lines, warnings: [], frontmatter: { slides_converted: `${pages.length}/${pages.length}` } };
}

function isTitle(frame: Element): boolean {
  const role = frame.getAttribute("presentation:class") ?? "";
  return role === "title" || role === "outline-title";
}

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

const TEXT_NODE = 3;

function renderInline(container: Element, context: OdfContext): string {
  // Only trimmed, not squashed: by this point the whitespace that remains was
  // put there deliberately — a `text:s` run of spaces, a `text:line-break`.
  // The incidental whitespace, which is the line wrapping in the XML source,
  // has already been collapsed per text node where it belongs.
  return renderInlineRaw(container, context, { bold: false, italic: false }).trim();
}

function renderInlineRaw(
  container: Element,
  context: OdfContext,
  format: { bold: boolean; italic: boolean }
): string {
  let out = "";

  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      // XML is written wrapped at whatever width the writer chose, and those
      // newlines are markup whitespace rather than line breaks in the text.
      // ODF says so explicitly, which is why it has `text:line-break` and
      // `text:s` for the whitespace that *is* content.
      out += emphasise(escapeInline((node.textContent ?? "").replace(/\s+/g, " ")), format);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;

    switch (element.tagName) {
      case "text:span": {
        const style = context.textStyles.get(element.getAttribute("text:style-name") ?? "");
        out += renderInlineRaw(element, context, {
          bold: format.bold || (style?.bold ?? false),
          italic: format.italic || (style?.italic ?? false),
        });
        break;
      }

      case "text:a": {
        const inner = renderInlineRaw(element, context, format);
        const href = element.getAttribute("xlink:href");
        out += href && inner.trim() !== "" ? `[${inner}](${href})` : inner;
        break;
      }

      // ODF compresses runs of spaces into a count, because XML would collapse
      // them; expanding it back is the difference between aligned text and one
      // long word.
      case "text:s":
        out += " ".repeat(Math.min(Number(element.getAttribute("text:c") ?? "1") || 1, 100));
        break;

      case "text:tab":
        out += " ";
        break;

      case "text:line-break":
        out += "\n";
        break;

      case "text:note": {
        out += renderNote(element, context);
        break;
      }

      case "draw:frame": {
        // An image anchored inside a paragraph — a signature, an inline icon.
        out += renderFrame(element, context).join(" ");
        break;
      }

      // Markers with no text of their own.
      case "text:bookmark":
      case "text:bookmark-start":
      case "text:bookmark-end":
      case "text:soft-page-break":
      case "text:sequence-decls":
      case "office:annotation":
        break;

      default:
        out += renderInlineRaw(element, context, format);
    }
  }

  return out;
}

/**
 * A footnote or endnote. The body is moved to the end of the note and replaced
 * by a Markdown footnote reference, which is where a footnote goes in a
 * document that has no pages to put it at the bottom of.
 */
function renderNote(note: Element, context: OdfContext): string {
  const body = descendants(note, "text:note-body")[0];
  if (!body) return "";

  const text = renderFlow(body, context)
    .filter((line) => line.trim() !== "")
    .join(" ");
  if (text === "") return "";

  context.footnotes.push(text);
  return `[^${context.footnotes.length}]`;
}

function emphasise(text: string, format: { bold: boolean; italic: boolean }): string {
  if (text === "" || (!format.bold && !format.italic)) return text;
  const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
  if (core === "") return text;

  let wrapped = core;
  if (format.italic) wrapped = `*${wrapped}*`;
  if (format.bold) wrapped = `**${wrapped}**`;
  return `${leading}${wrapped}${trailing}`;
}

// ---------------------------------------------------------------------------
// Rows, columns and their repeat counts
// ---------------------------------------------------------------------------

/**
 * ODF stores a run of identical cells once with a repeat count, which is how a
 * spreadsheet's million empty columns fit in a small file. Expanding blindly
 * would produce those million columns; expanding only what's left after the
 * trailing blanks are dropped produces the table that was actually filled in.
 */
const MAX_REPEAT = 4096;

function tableRows(tableElement: Element): Element[] {
  const rows: Element[] = [];
  const collect = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (child.tagName === "table:table-row") {
        const repeat = repeatCount(child, "table:number-rows-repeated");
        for (let copy = 0; copy < repeat; copy++) rows.push(child);
      } else if (
        child.tagName === "table:table-header-rows" ||
        child.tagName === "table:table-rows" ||
        child.tagName === "table:table-row-group"
      ) {
        collect(child);
      }
    }
  };
  collect(tableElement);
  return rows;
}

function readRowCells(row: Element, render: (cell: Element) => string): string[] {
  const runs: { text: string; repeat: number }[] = [];

  for (const cell of Array.from(row.children)) {
    if (cell.tagName !== "table:table-cell" && cell.tagName !== "table:covered-table-cell") continue;
    // A covered cell is the part of a merge that isn't the top-left one; it
    // holds no content and exists to keep the grid rectangular.
    const text = cell.tagName === "table:covered-table-cell" ? "" : render(cell);
    runs.push({ text, repeat: repeatCount(cell, "table:number-columns-repeated") });
  }

  while (runs.length > 0 && runs[runs.length - 1].text.trim() === "") runs.pop();

  const cells: string[] = [];
  for (const run of runs) {
    for (let copy = 0; copy < run.repeat && cells.length < MAX_REPEAT; copy++) cells.push(run.text);
  }
  return cells;
}

function repeatCount(element: Element, attribute: string): number {
  const value = Number(element.getAttribute(attribute) ?? "1");
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.min(Math.floor(value), MAX_REPEAT);
}

function trimEmptyRows(rows: string[][]): string[][] {
  const trimmed = [...rows];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].every((cell) => cell.trim() === "")) trimmed.pop();
  return trimmed;
}

// ---------------------------------------------------------------------------
// Styles and metadata
// ---------------------------------------------------------------------------

/**
 * Bold and italic per text style.
 *
 * ODF puts formatting in a named style even when it was applied by hand: the
 * word someone bolded becomes a `text:span` pointing at an automatic style
 * called `T3`, defined elsewhere in the file. Without resolving that, every
 * document comes out with no emphasis at all.
 */
function readTextStyles(zip: ZipArchive, content: Document): Map<string, { bold: boolean; italic: boolean }> {
  const styles = new Map<string, { bold: boolean; italic: boolean }>();

  for (const document of styleDocuments(zip, content)) {
    for (const style of descendants(document, "style:style")) {
      if (style.getAttribute("style:family") !== "text") continue;
      const name = style.getAttribute("style:name");
      if (!name) continue;

      const properties = children(style, "style:text-properties")[0];
      const weight = properties?.getAttribute("fo:font-weight") ?? "";
      const posture = properties?.getAttribute("fo:font-style") ?? "";
      styles.set(name, {
        bold: weight !== "" && weight !== "normal",
        italic: posture === "italic" || posture === "oblique",
      });
    }
  }

  return styles;
}

/** Whether each level of each list style is numbered rather than bulleted. */
function readListStyles(zip: ZipArchive, content: Document): Map<string, Map<number, boolean>> {
  const styles = new Map<string, Map<number, boolean>>();

  for (const document of styleDocuments(zip, content)) {
    for (const listStyle of descendants(document, "text:list-style")) {
      const name = listStyle.getAttribute("style:name");
      if (!name) continue;

      const levels = styles.get(name) ?? new Map<number, boolean>();
      for (const level of Array.from(listStyle.children)) {
        const index = Number(level.getAttribute("text:level") ?? "1");
        if (!Number.isFinite(index)) continue;
        levels.set(index, level.tagName === "text:list-level-style-number");
      }
      styles.set(name, levels);
    }
  }

  return styles;
}

/** Table styles carrying `table:display="false"` — a spreadsheet's hidden sheets. */
function readHiddenTables(zip: ZipArchive, content: Document): Set<string> {
  const hidden = new Set<string>();

  for (const document of styleDocuments(zip, content)) {
    for (const style of descendants(document, "style:style")) {
      if (style.getAttribute("style:family") !== "table") continue;
      const name = style.getAttribute("style:name");
      const properties = children(style, "style:table-properties")[0];
      if (name && properties?.getAttribute("table:display") === "false") hidden.add(name);
    }
  }

  return hidden;
}

/**
 * Both places a style can live: `content.xml` holds the automatic styles
 * generated for this document's direct formatting, `styles.xml` the named ones
 * shared across it. A span can point at either.
 */
function styleDocuments(zip: ZipArchive, content: Document): Document[] {
  const documents: Document[] = [content];
  const stylesXml = zip.text(STYLES);
  if (stylesXml) {
    try {
      documents.push(parseXml(stylesXml));
    } catch {
      // A malformed styles part costs emphasis, not text.
    }
  }
  return documents;
}

async function saveImages(zip: ZipArchive, content: Document, assets: AssetSink): Promise<Map<Element, string>> {
  const embeds = new Map<Element, string>();

  for (const image of descendants(content, "draw:image")) {
    const href = image.getAttribute("xlink:href");
    if (href) {
      const path = href.replace(/^\.\//, "");
      const extension = imageExtensionOf(path);
      const data = extension ? zip.bytes(path) : null;
      if (data && extension) {
        const embed = await assets.save(data, extension);
        if (embed) embeds.set(image, embed);
      }
      continue;
    }

    // A "flat" or freshly pasted image is stored inline as base64 rather than
    // as its own archive entry.
    const binary = descendants(image, "office:binary-data")[0]?.textContent;
    if (!binary) continue;
    const bytes = Buffer.from(binary.replace(/\s+/g, ""), "base64");
    const extension = imageExtensionForMime(image.getAttribute("draw:mime-type") ?? "image/png") ?? "png";
    if (bytes.length === 0) continue;
    const embed = await assets.save(bytes, extension);
    if (embed) embeds.set(image, embed);
  }

  return embeds;
}

function readMetadata(zip: ZipArchive): Record<string, string> {
  const xml = zip.text(META);
  if (!xml) return {};

  let meta: Document;
  try {
    meta = parseXml(xml);
  } catch {
    return {};
  }

  const frontmatter: Record<string, string> = {};
  const read = (tag: string) => descendants(meta, tag)[0]?.textContent?.replace(/\s+/g, " ").trim() || null;

  const title = read("dc:title");
  if (title) frontmatter.title = yamlValue(title);
  const author = read("meta:initial-creator") ?? read("dc:creator");
  if (author) frontmatter.author = yamlValue(author);

  return frontmatter;
}
