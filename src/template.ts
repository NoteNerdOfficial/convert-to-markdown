import { yamlValue } from "./markdown";

/**
 * Rendering a template note into a converted note.
 *
 * A template is an ordinary note the user writes, so it has to tolerate what
 * people actually type: `vendor: {{vendor}}` with no thought for the colon or
 * quote the vendor's name might contain, a placeholder dropped inside a quoted
 * title or a tag list, Templater code they mean to run afterwards. The engine
 * is placeholder substitution that knows where in the YAML it is — nothing
 * more. It is deliberately not a logic language: no conditions, no loops.
 *
 * It is pure on purpose. The date formatter and the clock come in from the
 * caller (Obsidian passes `window.moment`), so the same input always renders
 * the same note and the whole thing can be checked outside Obsidian.
 */

export interface TemplateInput {
  /** The template note's text. CRLF is accepted; the note is written with `\n`. */
  template: string;
  /** The document type's fields. `null` means the field wasn't found. Money is a number. */
  fields: Record<string, string | number | null>;
  /** Multi-line Markdown — `content`, `original`, tables like `line_items`. Body only. */
  blocks: Record<string, string>;
  /** Keys every note must carry, in order, with values already formatted as YAML. */
  coverage: [string, string][];
  /** Formats an ISO date (`YYYY-MM-DD…`) with a moment-style format string. */
  formatDate: (iso: string, format: string) => string;
  /** What `{{title}}`, `{{date}}` and `{{time}}` mean, as in Obsidian's core Templates. */
  now: { title: string; date: string; time: string; formatNow: (format: string) => string };
}

export interface TemplateOutput {
  note: string;
  /** Placeholders the template used that name nothing, in order of first use. */
  unknownPlaceholders: string[];
  /** Fields the template used that weren't found, in order of first use. */
  missing: string[];
  /** Things written differently from how the template asked, for the conversion notes. */
  problems: string[];
  /**
   * The template can't be used at all — its frontmatter opens and never
   * closes, so there's no telling where properties end and the note begins.
   * `note` is empty; the caller renders the built-in default instead and says
   * so, rather than guessing.
   */
  fatal: boolean;
}

/** The built-in invoice template, used when no template note is set. */
export const DEFAULT_INVOICE_TEMPLATE = `---
type: invoice
vendor: {{vendor}}
invoice_number: {{invoice_number}}
invoice_date: {{invoice_date}}
due_date: {{due_date}}
total: {{total}}
currency: {{currency}}
tags: [finance, invoices]
---
{{original}}

## Line items

{{line_items}}

{{content}}
`;

type Value =
  | { kind: "text"; text: string }
  | { kind: "number"; value: number }
  | { kind: "missing" }
  | { kind: "block"; text: string }
  | { kind: "unknown"; text: string };

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*)\s*(?::([^{}\n]*))?\}\}/g;
const WHOLE_LINE_PLACEHOLDER = /^\s*\{\{\s*[A-Za-z_][\w-]*\s*(?::[^{}\n]*)?\}\}\s*$/;
// Templater blocks and placeholders are swapped for these markers while the
// template is worked on, so nothing below can read into them, quote them or
// split them across lines; they're put back at the very end.
const CODE = /\u0000(\d+)\u0000/g;
const SLOT = /\u0001(\d+)\u0001/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function renderTemplate(input: TemplateInput): TemplateOutput {
  const unknown: string[] = [];
  const missing: string[] = [];
  const problems: string[] = [];
  const once = (list: string[], item: string) => list.includes(item) || list.push(item);
  const has = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

  const code: string[] = [];
  const text = input.template
    .replace(/\r\n?/g, "\n")
    .replace(/<%[\s\S]*?%>/g, (block) => `\u0000${code.push(block) - 1}\u0000`);

  const resolve = (literal: string, name: string, format: string | undefined, inFrontmatter: boolean): Value => {
    const unformattable = (value: Value): Value => {
      if (format !== undefined) once(problems, `${literal} has a format, but ${name} isn't a date, so it was written unformatted.`);
      return value;
    };
    if (name === "title") return unformattable({ kind: "text", text: input.now.title });
    if (name === "date" || name === "time") {
      return { kind: "text", text: format !== undefined ? input.now.formatNow(format) : input.now[name] };
    }
    if (has(input.blocks, name)) {
      if (!inFrontmatter) return unformattable({ kind: "block", text: input.blocks[name] });
      once(problems, `${literal} is a block of Markdown and can't go in frontmatter, so it was left empty.`);
      return { kind: "missing" };
    }
    if (has(input.fields, name)) {
      const value = input.fields[name];
      if (value === null) {
        once(missing, name);
        return { kind: "missing" };
      }
      if (typeof value === "number") return unformattable({ kind: "number", value });
      if (format !== undefined && ISO_DATE.test(value)) return { kind: "text", text: input.formatDate(value, format) };
      return unformattable({ kind: "text", text: value });
    }
    once(unknown, name);
    return { kind: "unknown", text: literal };
  };

  const lines = text.split("\n");
  let frontmatter: string[] | null = null;
  let body = lines;
  if (/^---\s*$/.test(lines[0])) {
    const close = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
    if (close < 0) {
      problems.push("The template's frontmatter opens with --- but never closes, so the template can't be read.");
      return { note: "", unknownPlaceholders: unknown, missing, problems, fatal: true };
    }
    frontmatter = renderFrontmatter(lines.slice(1, close), input.coverage, resolve, problems);
    body = lines.slice(close + 1);
  } else if (input.coverage.length > 0) {
    frontmatter = renderFrontmatter([], input.coverage, resolve, problems);
  }

  // Body: fields are plain text and blocks go in verbatim. A placeholder alone
  // on its line that comes out empty takes its line with it, and the blank
  // line after it too when there's one before it, so a missing `{{original}}`
  // doesn't leave a gap.
  const out: string[] = [];
  let swallowBlank = false;
  for (const line of body) {
    if (swallowBlank && line.trim() === "") {
      swallowBlank = false;
      continue;
    }
    swallowBlank = false;
    const rendered = line.replace(PLACEHOLDER, (literal, name: string, format: string | undefined, at: number) => {
      const value = resolve(literal, name, format, false);
      const result = asText(value);
      // A multi-line block placed after a list marker's indent or a `>`
      // carries that prefix onto every line, so it stays inside the callout.
      const lead = line.slice(0, at);
      return value.kind === "block" && /^[\s>]*$/.test(lead) ? result.replace(/\n/g, `\n${lead}`) : result;
    });
    if (WHOLE_LINE_PLACEHOLDER.test(line) && rendered.trim() === "") {
      swallowBlank = out.length === 0 || out[out.length - 1].trim() === "";
      continue;
    }
    out.push(rendered);
  }

  const head = frontmatter === null ? "" : `${["---", ...frontmatter, "---"].join("\n")}\n`;
  const note = `${head}${out.join("\n")}`.replace(CODE, (_, i: string) => code[Number(i)]).replace(/\n+$/, "");
  return { note: `${note}\n`, unknownPlaceholders: unknown, missing, problems, fatal: false };
}

function asText(value: Value): string {
  if (value.kind === "missing") return "";
  if (value.kind === "number") return String(value.value);
  return value.text;
}

/**
 * Frontmatter, line by line. A whole-value placeholder becomes a YAML scalar;
 * one inside a quoted value is escaped for those quotes; one inside a bare
 * value turns the whole value into a string template, quoted as a whole if it
 * needs to be. Lines are only ever rewritten into valid YAML — anything the
 * engine can't place safely is reported and left empty instead.
 */
function renderFrontmatter(
  lines: string[],
  coverage: [string, string][],
  resolve: (literal: string, name: string, format: string | undefined, inFrontmatter: boolean) => Value,
  problems: string[]
): string[] {
  const out: string[] = [];
  const placed = new Set<string>();
  const covered = new Map(coverage);
  let skipping = false;
  let blockIndent: number | null = null;

  for (const line of lines) {
    const indent = (/^\s*/.exec(line) ?? [""])[0].length;
    // A coverage key the template placed itself keeps its position, but its
    // value — including any indented or list lines under it — is ours.
    if (skipping && (/^[\s-]/.test(line) || line === "")) continue;
    skipping = false;
    const top = /^([^\s#'"{[\-?:][^:]*?|"[^"]*"|'[^']*')\s*:(?:\s|$)/.exec(line);
    const topKey = top?.[1].replace(/^(["'])(.*)\1$/, "$2");
    if (topKey !== undefined && covered.has(topKey)) {
      if (!placed.has(topKey)) out.push(entry(topKey, covered.get(topKey) ?? ""));
      placed.add(topKey);
      skipping = true;
      blockIndent = null;
      continue;
    }

    const values: Value[] = [];
    const masked = line.replace(PLACEHOLDER, (literal, name: string, format: string | undefined) => {
      values.push(resolve(literal, name, format, true));
      return `\u0001${values.length - 1}\u0001`;
    });
    const fill = (s: string, escape: (t: string) => string) =>
      s.replace(SLOT, (_, i: string) => escape(asText(values[Number(i)])));

    // Lines under `key: |` or `key: >` are literal text.
    if (blockIndent !== null && (line.trim() === "" || indent > blockIndent)) {
      out.push(fill(masked, (t) => t.replace(/\n/g, `\n${" ".repeat(indent)}`)));
      continue;
    }
    blockIndent = null;

    const shape = /^(\s*(?:-(?:\s+|$))*)(?:([^\s#'"{[\-?:|>!&*\u0001][^\u0001]*?|"[^"]*"|'[^']*')\s*:(?:\s+|$))?/.exec(masked);
    const prefix = shape?.[0] ?? "";
    const isItem = /-/.test(shape?.[1] ?? "");
    if (!shape || (!shape[2] && !isItem)) {
      if (values.length === 0 || /^\s*#/.test(masked)) out.push(fill(masked, (t) => t.replace(/\n+/g, " ")));
      else problems.push(`A placeholder in the frontmatter line "${line.trim()}" isn't in a value, so the line was left out.`);
      continue;
    }

    const [value, comment] = splitComment(masked.slice(prefix.length));
    const tail = comment ? ` ${comment}` : "";
    if (/^[|>][-+1-9]*$/.test(value)) blockIndent = indent;
    if (values.length === 0) {
      out.push(line);
      continue;
    }

    const rendered = renderValue(value, values, fill, problems, line);
    if (rendered === null && isItem && !shape[2]) continue;
    out.push(rendered === null ? `${prefix.trimEnd()}${tail}` : `${prefix}${rendered}${tail}`);
  }

  for (const [key, value] of coverage) if (!placed.has(key)) out.push(entry(key, value));
  return out;
}

function entry(key: string, value: string): string {
  return value === "" ? `${key}:` : `${key}: ${value}`;
}

/** A frontmatter value with placeholders in it, or null for an empty value. */
function renderValue(
  value: string,
  values: Value[],
  fill: (s: string, escape: (t: string) => string) => string,
  problems: string[],
  line: string
): string | null {
  const whole = /^\u0001(\d+)\u0001$/.exec(value);
  if (whole) return scalar(values[Number(whole[1])], problems);
  if (/^".*"$/.test(value)) return fill(value, (t) => escapeDouble(t));
  if (/^'.*'$/.test(value)) {
    // Single quotes have no escapes at all, so control characters can only go.
    return fill(value, (t) => t.replace(/\s*\n\s*/g, " ").replace(/[\u0002-\u0008\u000b-\u001f\u007f]/g, "").replace(/'/g, "''"));
  }
  if (/^\[[^[\]{}]*\]$/.test(value)) {
    const items = splitFlow(value.slice(1, -1));
    if (items !== null) {
      const kept = items
        .map((item) => (item.includes("\u0001") ? renderValue(item, values, fill, problems, line) : item))
        .filter((item): item is string => item !== null && item !== "");
      return `[${kept.join(", ")}]`;
    }
  }
  if (/^[[{"'|>!&*]/.test(value)) {
    problems.push(`A placeholder in the frontmatter line "${line.trim()}" is somewhere it can't be written safely, so the value was left empty.`);
    return null;
  }
  if (value.includes("\u0000")) {
    // Bare text with Templater code in it can't be quoted — quoting would
    // escape the code — so each value has to be safe on its own.
    const kept = fill(value, (t) => {
      const flat = t.replace(/[\r\n]+/g, " ").trim();
      if (flat === "" || yamlValue(flat) === flat) return flat;
      problems.push(`A value in the frontmatter line "${line.trim()}" can't sit unquoted beside Templater code, so it was left out.`);
      return "";
    }).trim();
    return kept === "" ? null : kept;
  }
  const textValue = fill(value, (t) => t).replace(/[\r\n]+/g, " ").trim();
  return textValue === "" ? null : yamlString(textValue);
}

function scalar(value: Value, problems: string[]): string | null {
  if (value.kind === "missing") return null;
  if (value.kind !== "number") return yamlString(value.text);
  if (Number.isFinite(value.value)) return String(value.value);
  problems.push(`A number field came out as ${value.value}, so it was left empty.`);
  return null;
}

/** A string as YAML: bare where `yamlValue` would leave it bare and YAML would still read a string. */
function yamlString(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").trim();
  return yamlValue(flat) === flat ? flat : `"${escapeDouble(flat)}"`;
}

function escapeDouble(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\u0002-\u0008\u000b-\u001f\u007f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** Splits a value from a trailing ` # comment`, minding quotes. */
function splitComment(text: string): [string, string] {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === '"' && c === "\\") i++;
    else if (quote !== "" && c === quote) quote = "";
    else if (quote === "" && (c === '"' || c === "'") && (i === 0 || /[\s[,]/.test(text[i - 1]))) quote = c;
    else if (quote === "" && c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return [text.slice(0, i).trim(), text.slice(i)];
    }
  }
  return [text.trim(), ""];
}

/** The items of a flat flow list, or null when quotes don't balance. */
function splitFlow(inner: string): string[] | null {
  const items: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote === '"' && c === "\\") i++;
    else if (quote !== "" && c === quote) quote = "";
    else if (quote === "" && (c === '"' || c === "'") && inner.slice(start, i).trim() === "") quote = c;
    else if (quote === "" && c === ",") {
      items.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote !== "") return null;
  items.push(inner.slice(start).trim());
  return items;
}
