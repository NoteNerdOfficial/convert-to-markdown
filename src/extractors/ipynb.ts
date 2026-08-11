import { AssetSink } from "../assets";
import { documentRoot, parseHtml, renderHtml } from "../html";
import { joinBlocks, yamlValue } from "../markdown";
import { decodeText } from "../text";
import { ExtractResult } from "./types";

/**
 * .ipynb → Markdown.
 *
 * A notebook is the easiest format here to read and the easiest to convert
 * badly. It is JSON with an explicit list of cells, each already labelled as
 * prose, code or output — nothing has to be inferred. The mistake is treating
 * the outputs as an afterthought: a notebook's output *is* half its content,
 * and it arrives as a bundle of alternative representations of the same thing
 * — a PNG, an HTML table, a plain-text fallback — from which exactly one
 * should be chosen.
 *
 * So the richest representation that Markdown can actually carry wins. A
 * plotted figure becomes an embedded image rather than `<Figure size 640x480>`,
 * and a DataFrame becomes a Markdown table, because pandas ships one as HTML
 * and its plain-text alternative is a fixed-width block that only lines up in
 * a monospaced font.
 */
export async function extractIpynb(data: Buffer, assets: AssetSink): Promise<ExtractResult> {
  const notebook = parseNotebook(decodeText(data));
  const cells = readCells(notebook);
  if (cells.length === 0) throw new Error("notebook has no cells");

  const language = languageOf(notebook);
  const context: NotebookContext = { assets, language, droppedOutputs: new Set(), unsavedImages: 0 };

  const lines: string[] = [];
  let converted = 0;

  for (const cell of cells) {
    const rendered = await renderCell(cell, context);
    if (rendered.length > 0) lines.push("", ...rendered, "");
    converted++;
  }

  const frontmatter: Record<string, string> = { cells_converted: `${converted}/${cells.length}` };
  const kernel = asRecord(asRecord(notebook.metadata)?.kernelspec)?.display_name;
  if (typeof kernel === "string" && kernel !== "") frontmatter.kernel = yamlValue(kernel);
  if (language) frontmatter.language = yamlValue(language);

  return { markdown: joinBlocks(lines), warnings: describeGaps(context), frontmatter };
}

interface NotebookContext {
  assets: AssetSink;
  language: string;
  /** MIME types that were present but had nothing Markdown could show. */
  droppedOutputs: Set<string>;
  unsavedImages: number;
}

type Json = Record<string, unknown>;

function parseNotebook(text: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not a readable notebook (invalid JSON: ${error instanceof Error ? error.message : "unknown"})`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("not a readable notebook (not a JSON object)");
  return parsed as Json;
}

/**
 * The cell list, from either notebook layout. Format 4 puts cells at the top
 * level; format 3 and earlier wrapped them in `worksheets`, a concept Jupyter
 * abandoned but which is still sitting in every notebook written before 2015.
 */
function readCells(notebook: Json): Json[] {
  const top = notebook.cells;
  if (Array.isArray(top)) return top.filter(isRecord);

  const worksheets = notebook.worksheets;
  if (!Array.isArray(worksheets)) return [];
  return worksheets.flatMap((sheet) => (isRecord(sheet) && Array.isArray(sheet.cells) ? sheet.cells.filter(isRecord) : []));
}

function languageOf(notebook: Json): string {
  const metadata = asRecord(notebook.metadata);
  const info = asRecord(metadata?.language_info);
  const kernelspec = asRecord(metadata?.kernelspec);
  for (const value of [info?.name, kernelspec?.language, kernelspec?.name]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim().toLowerCase();
  }
  return "";
}

async function renderCell(cell: Json, context: NotebookContext): Promise<string[]> {
  // Format 3 spelled a code cell's source `input`; everything else used
  // `source` then as it does now.
  const source = textOf(cell.source ?? cell.input);
  const type = typeof cell.cell_type === "string" ? cell.cell_type : "raw";

  if (type === "markdown") {
    // Already Markdown — passing it through a converter is the one thing that
    // could only make it worse. The single edit is resolving the images the
    // notebook carries inline, which are addressed by a scheme nothing outside
    // Jupyter understands.
    const text = await resolveAttachments(source, cell, context);
    return text.trim() === "" ? [] : [text.trim()];
  }

  // Format 3's heading cells, replaced in format 4 by ordinary Markdown.
  if (type === "heading") {
    const level = Math.min(Math.max(Number(cell.level ?? 1) || 1, 1), 6);
    return source.trim() === "" ? [] : [`${"#".repeat(level)} ${source.trim()}`];
  }

  const lines: string[] = [];
  if (source.trim() !== "") lines.push(...fence(source, type === "code" ? context.language : ""));

  if (type === "code") {
    const outputs = Array.isArray(cell.outputs) ? cell.outputs.filter(isRecord) : [];
    for (const output of outputs) {
      const rendered = await renderOutput(output, context);
      if (rendered.length > 0) lines.push("", ...rendered);
    }
  }

  return lines;
}

async function renderOutput(output: Json, context: NotebookContext): Promise<string[]> {
  switch (output.output_type) {
    case "stream": {
      const text = textOf(output.text);
      if (text.trim() === "") return [];
      // stderr is where warnings and progress bars land; saying so keeps a
      // deprecation notice from reading like the cell's result.
      const label = output.name === "stderr" ? ["*stderr*"] : [];
      return [...label, ...fence(stripAnsi(text), "")];
    }

    case "error":
    case "pyerr": {
      const name = typeof output.ename === "string" ? output.ename : "Error";
      const value = typeof output.evalue === "string" ? output.evalue : "";
      const traceback = Array.isArray(output.traceback) ? output.traceback.map(String).join("\n") : "";
      const heading = `**${name}${value === "" ? "" : `: ${value}`}**`;
      // Tracebacks are written with ANSI colour codes; left in, they read as
      // line noise wrapped around every frame.
      return traceback.trim() === "" ? [heading] : [heading, "", ...fence(stripAnsi(traceback), "")];
    }

    case "execute_result":
    case "display_data":
    case "pyout":
      return renderBundle(asRecord(output.data) ?? legacyBundle(output), context);

    default:
      if (typeof output.output_type === "string") context.droppedOutputs.add(output.output_type);
      return [];
  }
}

/**
 * Format 3 had no `data` bundle: each MIME type was its own key on the output,
 * under a short name. Rewriting them into a bundle lets one renderer serve
 * both layouts.
 */
function legacyBundle(output: Json): Json {
  const bundle: Json = {};
  const names: Record<string, string> = {
    text: "text/plain",
    html: "text/html",
    png: "image/png",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
    latex: "text/latex",
  };
  for (const [key, mime] of Object.entries(names)) {
    if (output[key] !== undefined) bundle[mime] = output[key];
  }
  return bundle;
}

/**
 * Picks one representation out of an output bundle.
 *
 * The order is what Markdown can carry, best first: a raster image embeds, an
 * HTML table becomes a real table, Markdown passes straight through, and plain
 * text is the fallback that always exists. Everything below the chosen one is
 * the same value said again, so taking more than one would duplicate the
 * output rather than complete it.
 */
async function renderBundle(bundle: Json, context: NotebookContext): Promise<string[]> {
  const types = Object.keys(bundle);

  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/svg+xml"]) {
    if (bundle[mime] === undefined) continue;
    const embed = await saveInlineImage(bundle[mime], mime, context);
    if (embed) return [embed];
    context.unsavedImages++;
    break;
  }

  if (bundle["text/markdown"] !== undefined) {
    const text = textOf(bundle["text/markdown"]);
    if (text.trim() !== "") return [text];
  }

  if (bundle["text/html"] !== undefined) {
    const rendered = renderHtmlOutput(textOf(bundle["text/html"]));
    if (rendered.length > 0) return rendered;
  }

  if (bundle["text/plain"] !== undefined) {
    const text = textOf(bundle["text/plain"]);
    if (text.trim() !== "") return fence(stripAnsi(text), "");
  }

  // Nothing renderable in the whole bundle — an interactive widget, a Vega
  // spec, a JavaScript-drawn plot. Naming the type is the useful part: it
  // says what to go back to the notebook for.
  for (const mime of types) {
    if (mime !== "text/plain") context.droppedOutputs.add(mime);
  }
  return [];
}

/**
 * Renders an HTML output — which in practice means a DataFrame.
 *
 * pandas emits its tables as HTML and its `text/plain` alternative as a
 * fixed-width block that only lines up in a monospaced font, so this is the
 * difference between a table you can sort in Obsidian and a wall of padded
 * digits.
 */
function renderHtmlOutput(html: string): string[] {
  if (html.trim() === "") return [];
  try {
    const root = documentRoot(parseHtml(html));
    if (!root) return [];
    const rendered = joinBlocks(renderHtml(root, { images: new Map() }));
    return rendered.trim() === "" ? [] : rendered.split("\n");
  } catch {
    return [];
  }
}

/**
 * Rewrites `attachment:` references in a Markdown cell.
 *
 * An image pasted into a Markdown cell is stored inside the notebook and
 * addressed as `![alt](attachment:diagram.png)` — a scheme that resolves
 * nowhere outside Jupyter, so left alone it is a broken image in every reader.
 */
async function resolveAttachments(source: string, cell: Json, context: NotebookContext): Promise<string> {
  const attachments = asRecord(cell.attachments);
  if (!attachments || !source.includes("attachment:")) return source;

  let text = source;
  for (const [name, bundle] of Object.entries(attachments)) {
    const data = asRecord(bundle);
    if (!data) continue;
    const mime = Object.keys(data).find((key) => key.startsWith("image/"));
    if (!mime) continue;

    const embed = await saveInlineImage(data[mime], mime, context);
    if (!embed) {
      context.unsavedImages++;
      continue;
    }
    // Replace the whole image element, since an Obsidian embed carries its own
    // syntax and can't be dropped into the parentheses of a Markdown image.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`!\\[[^\\]]*\\]\\(attachment:${escaped}\\)`, "g"), embed);
  }
  return text;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

async function saveInlineImage(value: unknown, mime: string, context: NotebookContext): Promise<string | null> {
  const extension = IMAGE_EXTENSIONS[mime];
  if (!extension) return null;

  // SVG is stored as markup, every other image type as base64.
  const payload = textOf(value);
  if (payload.trim() === "") return null;
  const bytes =
    mime === "image/svg+xml" ? Buffer.from(payload, "utf8") : Buffer.from(payload.replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) return null;

  return context.assets.save(bytes, extension);
}

function describeGaps(context: NotebookContext): string[] {
  const warnings: string[] = [];

  if (context.unsavedImages > 0) {
    warnings.push(
      context.assets.enabled
        ? `${context.unsavedImages} output image${context.unsavedImages === 1 ? "" : "s"} could not be decoded and ${
            context.unsavedImages === 1 ? "was" : "were"
          } left out.`
        : `${context.unsavedImages} output image${
            context.unsavedImages === 1 ? "" : "s"
          } left out (image extraction is off in settings).`
    );
  }
  if (context.droppedOutputs.size > 0) {
    warnings.push(
      `Outputs with nothing Markdown can show, dropped by type: ${[...context.droppedOutputs].sort().join(", ")}. ` +
        "These are usually interactive widgets or JavaScript-drawn plots."
    );
  }

  return warnings;
}

/** Notebook text fields are a string or a list of lines that were split on newlines. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((line) => (typeof line === "string" ? line : "")).join("");
  return "";
}

function fence(text: string, language: string): string[] {
  const body = text.replace(/\n+$/, "");
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const marker = "`".repeat(Math.max(3, longest + 1));
  return [`${marker}${language}`, body, marker];
}

/**
 * Strips terminal colour codes. Jupyter stores what the kernel actually wrote
 * to the stream, escape sequences and all, and a coloured traceback is mostly
 * escape sequences by character count.
 */
// eslint-disable-next-line no-control-regex -- \u001b (ESC) is the byte that starts an ANSI escape sequence, matched deliberately.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Json | null {
  return isRecord(value) ? value : null;
}
