/**
 * Markdown assembly helpers shared by every extractor.
 *
 * The whole point of this plugin over a generalist converter is that each
 * format decides for itself how its structure maps onto Markdown — so these
 * stay dumb on purpose: they emit, they don't interpret.
 */

/** Escapes the characters that would otherwise turn body text into markup. */
export function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]{}<>])/g, "\\$1");
}

/**
 * Escapes for a table cell. Cell content arrives as already-rendered inline
 * Markdown (a bold run in a Word table is `**text**` by the time it gets
 * here), so this must *not* escape it again — it only handles the two things
 * a table row itself can't contain: a literal `|`, and a line break.
 */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function heading(level: number, text: string): string {
  const clamped = Math.min(Math.max(level, 1), 6);
  return `${"#".repeat(clamped)} ${text}`;
}

export function bullet(depth: number, text: string): string {
  return `${"  ".repeat(Math.max(depth, 0))}- ${text}`;
}

export function numbered(depth: number, text: string): string {
  return `${"  ".repeat(Math.max(depth, 0))}1. ${text}`;
}

/**
 * Renders a table. Markdown requires a header row, so a table whose first row
 * isn't really a header still has to give up its first row for one — that's a
 * limitation of the target format, not a choice.
 */
export function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => {
    const cells = row.map(escapeCell);
    while (cells.length < width) cells.push("");
    return `| ${cells.join(" | ")} |`;
  };

  const [header, ...body] = rows;
  return [pad(header), `| ${Array(width).fill("---").join(" | ")} |`, ...body.map(pad)];
}

/**
 * Collapses runs of blank lines to at most one and trims the ends, so
 * extractors can emit separators freely without tracking what came before.
 */
export function joinBlocks(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const isBlank = line.trim() === "";
    if (isBlank && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(isBlank ? "" : line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/**
 * The text of the first heading, if the content opens with one.
 *
 * Three formats name a document twice — an email's `Subject` and the `<h1>` of
 * its HTML body, a page's `<title>` and its own headline, an epub's contents
 * entry and the chapter's own heading. Each of those names is worth adding
 * when the content doesn't already carry it, and is a duplicate when it does.
 */
export function openingHeading(lines: string[]): string | null {
  const first = lines.find((line) => line.trim() !== "");
  if (first === undefined || !/^#{1,6}\s/.test(first)) return null;
  // Comparison is against a plain string, so the Markdown the heading picked
  // up on the way in has to come back off.
  return first
    .replace(/^#+\s*/, "")
    .replace(/\\([\\`*_[\]{}<>])/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
}

/** Whether content already opens with a heading naming it. */
export function alreadyTitled(lines: string[], title: string): boolean {
  const heading = openingHeading(lines);
  return heading !== null && heading.toLowerCase() === title.trim().toLowerCase();
}

/**
 * A frontmatter value that survives being read back as YAML.
 *
 * Coverage counts like `23/23` need nothing, but the moment a value is text
 * out of the source file — an email subject, a speaker's name, an epub's
 * author — it can contain a colon, a `#`, or a leading `-`, any of which turns
 * the line into something other than the string that was meant.
 */
export function yamlValue(text: string): string {
  const value = text.replace(/[\r\n]+/g, " ").trim();
  if (value === "") return '""';
  if (/^[A-Za-z0-9][A-Za-z0-9 ._/@+()–—-]*[A-Za-z0-9._/@+()]$/.test(value)) return value;
  if (/^[A-Za-z0-9]$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Normalises whitespace inside a text run without touching line structure. */
export function squashSpaces(text: string): string {
  return text.replace(/[ \t ]+/g, " ").trim();
}
