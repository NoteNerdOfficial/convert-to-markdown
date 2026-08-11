import { joinBlocks, table, yamlValue } from "../markdown";
import { decodeText } from "../text";
import { ExtractResult } from "./types";

/**
 * .csv / .tsv → a Markdown table.
 *
 * The temptation with delimited text is to split on the delimiter, which works
 * on the examples and fails on real files: a field can be quoted, a quoted
 * field can contain the delimiter, a quoted field can contain a line break,
 * and a quote inside a quoted field is written twice. Every one of those turns
 * up the moment the data has an address or a comment in it, and each one
 * silently shifts columns rather than failing loudly.
 *
 * So this is a character-by-character reader of RFC 4180, and the delimiter is
 * worked out from the file rather than assumed — a "CSV" exported by Excel on
 * a machine with a European locale is semicolon-separated, because the comma
 * is that locale's decimal point.
 */
export async function extractCsv(data: Buffer): Promise<ExtractResult> {
  return convert(data, null);
}

export async function extractTsv(data: Buffer): Promise<ExtractResult> {
  return convert(data, "\t");
}

/** Candidates in the order to prefer them when two score equally. */
const DELIMITERS = [",", ";", "\t", "|"];

const DELIMITER_NAMES: Record<string, string> = {
  ",": "comma",
  ";": "semicolon",
  "\t": "tab",
  "|": "pipe",
};

async function convert(data: Buffer, forced: string | null): Promise<ExtractResult> {
  let text = decodeText(data);
  const warnings: string[] = [];

  // Excel writes a `sep=;` line above the data when it exports with a
  // delimiter other than the one its reader would assume. It is an
  // instruction to the parser, not a row.
  let declared: string | null = null;
  const sepLine = /^sep=(.)\r?\n/i.exec(text);
  if (sepLine) {
    declared = sepLine[1];
    text = text.slice(sepLine[0].length);
    warnings.push(`The file began with \`${sepLine[0].trim()}\`, Excel's marker for a non-default delimiter.`);
  }

  if (text.trim() === "") throw new Error("the file is empty");

  const delimiter = forced ?? declared ?? sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (rows.length === 0) throw new Error("no rows found");

  const width = Math.max(...rows.map((row) => row.length));
  const ragged = rows
    .map((row, index) => (row.length === width ? null : index + 1))
    .filter((line): line is number => line !== null);

  if (ragged.length > 0) {
    // Named, not counted: a row that's short because a field was dropped is a
    // data problem worth going back to the source for, and the row number is
    // the only thing that makes that possible.
    const shown = ragged.slice(0, 10).join(", ");
    warnings.push(
      `${ragged.length} row${ragged.length === 1 ? "" : "s"} had fewer than ${width} fields and ` +
        `${ragged.length === 1 ? "was" : "were"} padded with empty cells — row${
          ragged.length === 1 ? "" : "s"
        } ${shown}${ragged.length > 10 ? ", …" : ""}.`
    );
  }

  // Markdown has no table without a header row, so the first row becomes one
  // whether or not it was meant as one. Saying so beats letting someone
  // conclude the file was missing its first record.
  if (rows.length > 1 && looksLikeData(rows[0])) {
    warnings.push(
      "The first row looks like data rather than column names, but Markdown tables require a header row, " +
        "so it is being used as one."
    );
  }

  return {
    markdown: joinBlocks(table(rows)),
    warnings,
    frontmatter: {
      rows: String(rows.length),
      columns: String(width),
      delimiter: yamlValue(DELIMITER_NAMES[delimiter] ?? delimiter),
    },
  };
}

/**
 * Works out the delimiter by parsing with each candidate and seeing which one
 * produces a rectangle.
 *
 * Counting raw occurrences is the obvious approach and the wrong one — a file
 * of prose fields has more commas inside its quoted text than between its
 * columns. A real delimiter is the one that gives the same field count on
 * nearly every line, so that consistency is what gets scored.
 */
function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = { delimiter: DELIMITERS[0], score: -1 };

  for (const delimiter of DELIMITERS) {
    const rows = parseDelimited(sample, delimiter).slice(0, 50);
    if (rows.length === 0) continue;

    const counts = new Map<number, number>();
    for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);

    let modal = 0;
    let modalRows = 0;
    for (const [fields, rowCount] of counts) {
      if (rowCount > modalRows || (rowCount === modalRows && fields > modal)) {
        modal = fields;
        modalRows = rowCount;
      }
    }

    // One field per row means the delimiter never appeared.
    const score = modal <= 1 ? 0 : modalRows * 100 + modal;
    if (score > best.score) best = { delimiter, score };
  }

  return best.delimiter;
}

/**
 * RFC 4180, plus the two liberties every real file takes: a lone quote in an
 * unquoted field is a literal quote, and rows may end with either line ending
 * or neither.
 */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quotedYet = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = "";
    started = false;
    quotedYet = false;
  };
  const endRow = () => {
    endField();
    // A trailing newline at the end of the file would otherwise add a row of
    // one empty field.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = false;
      }
      continue;
    }

    // A quote opens a quoted field only at the start of one. The whitespace
    // test is a liberty the standard doesn't grant and real files need: plenty
    // of exporters write `a, "b, c"`, and reading that quote as literal turns
    // one field into two and shifts every column after it.
    if (char === '"' && !quotedYet && field.trim() === "") {
      field = "";
      quoted = true;
      quotedYet = true;
      started = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === "\r") {
      if (text[index + 1] === "\n") index++;
      endRow();
      continue;
    }
    if (char === "\n") {
      endRow();
      continue;
    }
    field += char;
    started = true;
  }

  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** Whether a row reads as values rather than column names. */
function looksLikeData(row: string[]): boolean {
  const filled = row.filter((cell) => cell.trim() !== "");
  if (filled.length === 0) return true;
  // A header of pure numbers, or of dates, is a row of measurements that lost
  // its labels somewhere upstream.
  return filled.every((cell) => /^-?[\d.,%$€£\s]+$/.test(cell.trim()) || /^\d{4}-\d{2}-\d{2}/.test(cell.trim()));
}
