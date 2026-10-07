import { LayoutPage } from "../layout/page";
import { runsOf } from "../layout/tables";
import { FoundField } from "./fields";
import { DateOrder, parseDate } from "./values";

/**
 * What more than one document type needs: guesses for a field no label
 * names, and arithmetic on the amounts found.
 */

/**
 * The most prominent line near the top of the first page — the largest
 * type, or the first line when it's all one size, as on a till receipt —
 * passing over table rows and lines `skip` matches (the document's own
 * title: "INVOICE", "Account statement").
 */
export function prominentLine(pages: LayoutPage[], skip: RegExp): FoundField | null {
  const page = pages.find((candidate) => candidate.rows.length > 0);
  if (!page) return null;
  const top = page.rows[0].y;
  const bottom = page.rows[page.rows.length - 1].y;
  // Table rows are what was bought, never who sold it, whatever size
  // they're set in.
  const inTables = new Set(page.tables.flatMap((found) => page.rows.slice(found.first, found.last + 1)));
  const runs = page.rows
    .filter((row) => row.y <= top + (bottom - top) * 0.35 && !inTables.has(row))
    .flatMap((row) => runsOf(row, 1).map((run) => ({ run, y: row.y })))
    .filter(({ run }) => /\p{L}{2}/u.test(run.text) && !skip.test(run.text) && !run.text.includes(":"));
  if (runs.length === 0) return null;
  const largest = Math.max(...runs.map(({ run }) => run.size));
  const chosen = runs.find(({ run }) => run.size >= largest * 0.95) ?? runs[0];
  return { value: { kind: "text", text: chosen.run.text }, label: "", ocr: page.source === "ocr", page: page.page, y: chosen.y };
}

/** The first date near the top of the first page, for a receipt that prints one with no label. */
export function firstDate(pages: LayoutPage[], order: DateOrder): FoundField | null {
  const page = pages.find((candidate) => candidate.rows.length > 0);
  if (!page) return null;
  const top = page.rows[0].y;
  const bottom = page.rows[page.rows.length - 1].y;
  for (const row of page.rows) {
    if (row.y > top + (bottom - top) * 0.4) break;
    for (const run of runsOf(row, 1)) {
      const date = parseDate(run.text, order);
      if (date) return { value: { kind: "date", ...date }, label: "", ocr: page.source === "ocr", page: page.page, y: row.y };
    }
  }
  return null;
}

export function moneyOf(found: Map<string, FoundField>, key: string): number | null {
  const value = found.get(key)?.value;
  return value?.kind === "money" ? value.amount : null;
}

/** Amounts within a cent are equal: a document rounds each line, not the sum. */
export const TOLERANCE = 0.011;

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function format(value: number): string {
  return value.toFixed(2);
}
