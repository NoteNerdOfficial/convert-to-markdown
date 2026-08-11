import { AssetSink, imageExtensionForMime } from "./assets";
import { escapeInline, heading, table } from "./markdown";

/**
 * HTML → Markdown, shared by the three formats that are HTML underneath: a
 * saved web page, an `.epub` chapter, and the HTML alternative of an email.
 *
 * This is the one place in the plugin where a single reader serves several
 * formats, and it earns the exception: those three don't merely resemble each
 * other, they are literally the same markup in different envelopes. What
 * differs between them — where the bytes come from, how an `img` resolves,
 * what counts as the document — stays with each extractor, and only the
 * element-to-Markdown mapping lives here.
 *
 * The walk is deliberately structural: `h2` is a level-2 heading because the
 * author said so, a `table` becomes a table, a `pre` keeps its whitespace. It
 * never guesses meaning from styling — an `em` is emphasis, but a `div` with a
 * bold font is just a `div`.
 */

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * The element to start rendering from.
 *
 * Normally `body`, but a fragment rather than a whole page — a notebook's
 * DataFrame output, an email body that is a bare `<table>` — can be parsed
 * into an empty `body` with the content left on the document element instead,
 * depending on how forgiving the parser is about where a table may appear.
 * Taking whichever one actually holds something works for both.
 */
export function documentRoot(document: Document): Element | null {
  const body = document.body;
  if (body && body.children.length > 0) return body;
  const root = document.documentElement;
  if (root && root.children.length > 0) return root;
  return body ?? root ?? null;
}

export interface HtmlContext {
  /**
   * Markdown embed per `img` src, for images that were saved into the vault.
   * Filled by an up-front async pass so the walk itself stays synchronous —
   * the same arrangement the OOXML extractors use.
   */
  images: Map<string, string>;
  /** Called for an `img` whose bytes weren't available to save. */
  onUnresolvedImage?(src: string): void;
  /** Rewrites an href, e.g. to turn an epub's internal link into an anchor. */
  resolveHref?(href: string): string | null;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * Elements that never produce output and whose text is not content: script
 * and style would otherwise dump their source into the note, and the rest are
 * either interactive controls or graphics with no textual meaning.
 */
const IGNORED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "video",
  "audio",
  "map",
  "area",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "label",
  "link",
  "meta",
  "base",
  "title",
]);

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "center",
  "details",
  "div",
  "dl",
  "dd",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "html",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

/** Every `img` source in the subtree, in document order, deduplicated. */
export function collectImageSources(root: Element): string[] {
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const image of Array.from(root.getElementsByTagName("img"))) {
    const src = image.getAttribute("src")?.trim();
    if (src && !seen.has(src)) {
      seen.add(src);
      sources.push(src);
    }
  }
  return sources;
}

export interface ImageBytes {
  data: Buffer;
  extension: string;
}

/**
 * Decodes a `data:` URI, or returns null if the src isn't one.
 *
 * Handled here rather than per format because all three HTML-bearing formats
 * meet it: a saved page inlines its icons this way, an epub occasionally does,
 * and an email's HTML part can too.
 */
export function decodeDataUri(src: string): ImageBytes | null {
  const match = /^data:([^;,]+)(;[^,]*)?,([\s\S]*)$/i.exec(src.trim());
  if (!match) return null;

  const extension = imageExtensionForMime(match[1]);
  if (!extension) return null;

  const isBase64 = /;\s*base64/i.test(match[2] ?? "");
  const payload = match[3];
  const data = isBase64
    ? Buffer.from(payload.replace(/\s+/g, ""), "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");
  return data.length === 0 ? null : { data, extension };
}

/**
 * Saves the images a document references, returning the embed for each.
 *
 * `lookup` is where the formats differ and is the only thing they have to
 * supply: an epub finds the bytes in its own zip, an email in a sibling MIME
 * part, a saved page usually nowhere at all. `data:` URIs are resolved here
 * first, since they carry their bytes in the reference itself.
 */
export async function resolveImages(
  sources: string[],
  assets: AssetSink,
  lookup: (src: string) => ImageBytes | null
): Promise<{ images: Map<string, string>; unresolved: string[] }> {
  const images = new Map<string, string>();
  const unresolved: string[] = [];

  for (const src of sources) {
    const bytes = decodeDataUri(src) ?? lookup(src);
    if (!bytes) {
      unresolved.push(src);
      continue;
    }
    const embed = await assets.save(bytes.data, bytes.extension);
    if (embed) images.set(src, embed);
    else unresolved.push(src);
  }

  return { images, unresolved };
}

/**
 * Blocks that produce output themselves rather than by holding other blocks.
 * A `div` renders as whatever is inside it; a `table` renders as a table.
 */
const SELF_RENDERING = new Set(["table", "ul", "ol", "dl", "pre", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** Renders an element's contents as Markdown lines. */
export function renderHtml(root: Element, context: HtmlContext): string[] {
  const lines: string[] = [];
  // A fragment can *be* one of these rather than contain it — a notebook's
  // DataFrame output is a bare `<table>`. Descending into it would walk past
  // the element that carries the structure and emit its cells as loose text.
  if (SELF_RENDERING.has(tagOf(root))) renderBlock(root, context, lines);
  else renderChildren(root, context, lines);
  return lines;
}

function renderChildren(parent: Element, context: HtmlContext, out: string[]): void {
  // Inline children between two blocks form an implicit paragraph — HTML lets
  // a `div` hold bare text, and dropping it would lose real content.
  let inline: Node[] = [];
  const flush = () => {
    if (inline.length === 0) return;
    const text = renderInline(inline, context).trim();
    inline = [];
    if (text !== "") out.push("", text, "");
  };

  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === ELEMENT_NODE && isBlockElement(child as Element)) {
      flush();
      renderBlock(child as Element, context, out);
    } else {
      inline.push(child);
    }
  }
  flush();
}

function isBlockElement(element: Element): boolean {
  return BLOCK.has(tagOf(element));
}

function tagOf(element: Element): string {
  return element.tagName.toLowerCase();
}

function renderBlock(element: Element, context: HtmlContext, out: string[]): void {
  const tag = tagOf(element);
  if (IGNORED.has(tag)) return;

  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = renderInline(Array.from(element.childNodes), context).trim();
      if (text !== "") out.push("", heading(Number(tag[1]), text.replace(/\n+/g, " ")), "");
      return;
    }

    case "hr":
      out.push("", "---", "");
      return;

    case "pre": {
      // A `pre` is the one place whitespace is content, so its text is taken
      // verbatim rather than walked — the only thing read from inside it is
      // the language, off the `code` element's class.
      const text = (element.textContent ?? "").replace(/\n+$/, "");
      if (text.trim() === "") return;
      const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
      out.push("", `${fence}${codeLanguage(element)}`, text, fence, "");
      return;
    }

    case "blockquote": {
      const inner: string[] = [];
      renderChildren(element, context, inner);
      const quoted = trimBlankEnds(inner).map((line) => (line === "" ? ">" : `> ${line}`));
      if (quoted.length > 0) out.push("", ...quoted, "");
      return;
    }

    case "ul":
    case "ol":
      out.push("", ...renderList(element, context), "");
      return;

    case "table":
      out.push("", ...renderTable(element, context), "");
      return;

    case "dl":
      out.push("", ...renderDefinitionList(element, context), "");
      return;

    case "figcaption": {
      const text = renderInline(Array.from(element.childNodes), context).trim();
      if (text !== "") out.push("", `*${text}*`, "");
      return;
    }

    case "summary": {
      const text = renderInline(Array.from(element.childNodes), context).trim();
      if (text !== "") out.push("", `**${text}**`, "");
      return;
    }

    // Everything else — div, section, article, figure, header, p — is a
    // container. `p` is no different at this point: renderChildren already
    // emits its inline content as its own paragraph.
    default:
      renderChildren(element, context, out);
  }
}

function codeLanguage(pre: Element): string {
  const code = pre.getElementsByTagName("code").item(0);
  const classes = `${code?.getAttribute("class") ?? ""} ${pre.getAttribute("class") ?? ""}`;
  const match = /(?:^|\s)(?:language|lang|highlight)-([A-Za-z0-9+#-]+)/.exec(classes);
  return match ? match[1].toLowerCase() : "";
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

function renderList(list: Element, context: HtmlContext): string[] {
  const ordered = tagOf(list) === "ol";
  const start = Number(list.getAttribute("start") ?? "1");
  let index = Number.isFinite(start) ? start : 1;

  const out: string[] = [];
  for (const item of Array.from(list.children)) {
    if (tagOf(item) !== "li") continue;

    const inner: string[] = [];
    renderChildren(item, context, inner);
    const lines = tightenItem(trimBlankEnds(inner));
    const marker = ordered ? `${index++}.` : "-";
    if (lines.length === 0) continue;

    out.push(`${marker} ${lines[0]}`);
    // Continuation lines are indented past the marker, which is what makes a
    // nested list nest: the child list renders flat and the parent indents it.
    const padding = " ".repeat(marker.length + 1);
    for (const line of lines.slice(1)) out.push(line === "" ? "" : `${padding}${line}`);
  }
  return out;
}

/**
 * Drops the blank line HTML's structure puts between an item's text and a list
 * nested under it. Left in, it makes every list in the document a loose one,
 * which renders with a paragraph's spacing between every bullet.
 */
function tightenItem(lines: string[]): string[] {
  // Collapse first: an item's text and the list nested under it are separated
  // by two blank lines (one closing the paragraph, one opening the list), and
  // dropping only the second still leaves the item loose.
  const collapsed = lines.filter((line, index) => line !== "" || lines[index - 1] !== "");
  return collapsed.filter((line, index) => {
    if (line !== "") return true;
    const next = collapsed[index + 1];
    return next === undefined || !/^\s*(?:[-*+]|\d+\.)\s/.test(next);
  });
}

function renderDefinitionList(list: Element, context: HtmlContext): string[] {
  const out: string[] = [];
  for (const child of Array.from(list.children)) {
    const tag = tagOf(child);
    const text = renderInline(Array.from(child.childNodes), context).trim();
    if (text === "") continue;
    if (tag === "dt") out.push(`- **${text}**`);
    else if (tag === "dd") out.push(`  ${text}`);
  }
  return out;
}

/**
 * Renders an HTML table onto Markdown's fixed grid.
 *
 * The awkward part is spans. Markdown has no notion of a cell covering two
 * columns or two rows, but ignoring them doesn't just lose the merge — it
 * shifts every cell after it into the wrong column, which turns a readable
 * table into a wrong one. So the grid is laid out the way a browser lays it
 * out, with `colspan` filling the extra columns and `rowspan` reserving them
 * in the rows below, and the covered cells left empty.
 */
function renderTable(tableElement: Element, context: HtmlContext): string[] {
  const grid: string[][] = [];
  /** Columns still covered by a rowspan from an earlier row, and for how long. */
  const pending = new Map<number, { text: string; rows: number }>();

  for (const row of tableRows(tableElement)) {
    const cells: string[] = [];
    let column = 0;

    const placeCarried = () => {
      for (;;) {
        const carried = pending.get(column);
        if (!carried) break;
        // A spanned-over cell is left empty rather than repeated: repeating it
        // would read as the value having been measured twice.
        cells[column] = "";
        carried.rows--;
        if (carried.rows <= 0) pending.delete(column);
        column++;
      }
    };

    placeCarried();
    for (const cell of Array.from(row.children)) {
      const tag = tagOf(cell);
      if (tag !== "td" && tag !== "th") continue;

      const text = renderInline(Array.from(cell.childNodes), context).trim();
      const colspan = spanOf(cell, "colspan");
      const rowspan = spanOf(cell, "rowspan");

      cells[column] = text;
      if (rowspan > 1) pending.set(column, { text, rows: rowspan - 1 });
      column++;
      for (let extra = 1; extra < colspan; extra++) {
        cells[column] = "";
        if (rowspan > 1) pending.set(column, { text: "", rows: rowspan - 1 });
        column++;
      }
      placeCarried();
    }

    if (cells.length > 0) grid.push(Array.from(cells, (cell) => cell ?? ""));
  }

  return table(grid);
}

/** Rows in visual order, whether or not they're wrapped in a section element. */
function tableRows(tableElement: Element): Element[] {
  const rows: Element[] = [];
  const collect = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      const tag = tagOf(child);
      if (tag === "tr") rows.push(child);
      else if (tag === "thead" || tag === "tbody" || tag === "tfoot") collect(child);
    }
  };
  collect(tableElement);
  return rows;
}

function spanOf(cell: Element, attribute: string): number {
  const value = Number(cell.getAttribute(attribute) ?? "1");
  // Browsers cap these; an absurd colspan in hand-written markup would
  // otherwise produce a table thousands of columns wide.
  return Number.isFinite(value) && value > 1 ? Math.min(Math.floor(value), 100) : 1;
}

function renderInline(nodes: Node[], context: HtmlContext): string {
  let out = "";
  for (const node of nodes) {
    if (node.nodeType === TEXT_NODE) {
      // HTML collapses runs of whitespace, including the newlines the source
      // is wrapped at. Not collapsing them hard-wraps the note at whatever
      // width the page's author happened to use.
      out += escapeInline((node.textContent ?? "").replace(/\s+/g, " "));
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    out += renderInlineElement(node as Element, context);
  }
  return out;
}

function renderInlineElement(element: Element, context: HtmlContext): string {
  const tag = tagOf(element);
  if (IGNORED.has(tag)) return "";

  if (tag === "br") return "\n";
  if (tag === "img") return renderImage(element, context);

  if (tag === "code" || tag === "kbd" || tag === "samp" || tag === "tt") {
    // Code spans are literal: the text inside must not be escaped, only
    // fenced off with enough backticks to contain whatever it holds.
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text === "") return "";
    const fence = "`".repeat(longestBacktickRun(text) + 1);
    const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${fence}${pad}${text}${pad}${fence}`;
  }

  // A block element reached through inline content — a `div` inside a table
  // cell, say. Its children still have to come out; the block structure is
  // what can't survive here.
  const inner = renderInline(Array.from(element.childNodes), context);

  switch (tag) {
    case "a": {
      const href = linkTarget(element, context);
      if (!href) return inner;
      // An image wrapped in a link is already an embed; linking the embed
      // would nest two pieces of Markdown that don't nest.
      if (inner.startsWith("![[") || inner.startsWith("![")) return inner;
      return inner.trim() === "" ? "" : `[${inner}](${href})`;
    }
    case "em":
    case "i":
    case "cite":
    case "var":
    case "dfn":
      return wrap(inner, "*");
    case "strong":
    case "b":
      return wrap(inner, "**");
    case "del":
    case "s":
    case "strike":
      return wrap(inner, "~~");
    case "mark":
      return wrap(inner, "==");
    case "sup":
      return inner.trim() === "" ? inner : `<sup>${inner}</sup>`;
    case "sub":
      return inner.trim() === "" ? inner : `<sub>${inner}</sub>`;
    case "q":
      return inner.trim() === "" ? inner : `"${inner}"`;
    default:
      return inner;
  }
}

/** Applies an emphasis marker, keeping the whitespace outside it. */
function wrap(text: string, marker: string): string {
  const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
  if (core === "") return text;
  return `${leading}${marker}${core}${marker}${trailing}`;
}

function linkTarget(anchor: Element, context: HtmlContext): string | null {
  const href = anchor.getAttribute("href")?.trim();
  if (!href) return null;
  // `javascript:` links do something rather than point somewhere, so there is
  // nothing to link to once the page isn't running.
  if (/^javascript:/i.test(href)) return null;
  const resolved = context.resolveHref ? context.resolveHref(href) : href;
  if (!resolved) return null;
  // Spaces and parentheses would end the link target early.
  return /[\s()]/.test(resolved) ? `<${resolved}>` : resolved;
}

function renderImage(image: Element, context: HtmlContext): string {
  const src = image.getAttribute("src")?.trim();
  const alt = (image.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
  if (!src) return "";

  const embed = context.images.get(src);
  if (embed) return embed;

  context.onUnresolvedImage?.(src);
  // An image whose bytes aren't in the file — a remote `src` in a saved page —
  // can still be linked. The note renders it when there's a network, and the
  // address is kept either way, which is more than dropping it would leave.
  if (/^https?:\/\//i.test(src)) return `![${escapeInline(alt)}](${src})`;
  return alt === "" ? "" : `*[image: ${escapeInline(alt)}]*`;
}

function trimBlankEnds(lines: string[]): string[] {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first].trim() === "") first++;
  while (last > first && lines[last - 1].trim() === "") last--;
  return lines.slice(first, last);
}

/**
 * The part of a page that is the page.
 *
 * A saved web page is mostly not the article: navigation, a cookie banner, a
 * sidebar of related links, a footer of site-map columns. Converting all of it
 * buries the content, so the document's own structural markers are used to
 * find the content — `main`, `article`, ARIA roles, the handful of container
 * ids and classes that every publishing system emits.
 *
 * This is a heuristic and it is named as one: what got dropped is reported, so
 * a page that hides its article in a `div` nobody labelled is a visible
 * omission rather than a silently short note.
 */
export function findMainContent(doc: Document): { root: Element; dropped: string[] } {
  const body = doc.body ?? doc.documentElement;
  const dropped: string[] = [];

  const candidate =
    doc.getElementsByTagName("main").item(0) ??
    query(doc, '[role="main"]') ??
    singleArticle(doc) ??
    query(doc, "#content, #main, #main-content, .post-content, .entry-content, .article-body, .markdown-body");

  // A wrapper that turned out to hold almost nothing is worse than no
  // detection at all — better a note with the navigation in it than an empty
  // one, and the fallback is reported the same as anything else.
  const root = candidate && textLength(candidate) >= 200 ? candidate : body;

  for (const tag of ["nav", "header", "footer", "aside"]) {
    for (const element of Array.from(root.getElementsByTagName(tag))) {
      const words = (element.textContent ?? "").trim().split(/\s+/).filter(Boolean).length;
      if (words === 0) continue;
      dropped.push(`<${tag}> (${words} word${words === 1 ? "" : "s"})`);
      element.remove();
    }
  }

  return { root, dropped };
}

function singleArticle(doc: Document): Element | null {
  const articles = doc.getElementsByTagName("article");
  // Several `article` elements means an index page listing them, not one
  // article with the page's content in it.
  return articles.length === 1 ? articles.item(0) : null;
}

function query(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}

function textLength(element: Element): number {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().length;
}
