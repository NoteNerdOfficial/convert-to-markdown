import { LayoutPage } from "../layout/page";
import { DetectedTable, runsOf } from "../layout/tables";
import { escapeInline, squashSpaces, table } from "../markdown";
import { FieldSpec, findFields, FoundField, normalizeLabel } from "./fields";
import { DEFAULT_INVOICE_TEMPLATE } from "../template";
import { DocumentType, TypedResult } from "./types";
import { DateOrder, parseDate, parseMoney } from "./values";

const FIELDS: FieldSpec[] = [
  {
    key: "vendor",
    name: "Vendor",
    labels: ["sold by", "vendor", "seller", "supplier", "merchant", "billed by", "issued by", "from"],
    kind: "text",
    core: true,
    prefer: "first",
  },
  {
    key: "invoice_number",
    name: "Invoice number",
    labels: [
      "invoice #", "invoice no", "invoice number", "invoice id", "invoice", "inv #", "inv no",
      "receipt #", "receipt no", "receipt number", "bill #", "bill no", "bill number", "document no", "document number",
    ],
    kind: "id",
    core: true,
    prefer: "first",
  },
  {
    key: "invoice_date",
    name: "Invoice date",
    labels: ["invoice date", "date of issue", "issue date", "issued", "date issued", "billing date", "bill date", "receipt date", "date"],
    kind: "date",
    core: true,
    prefer: "first",
  },
  {
    key: "due_date",
    name: "Due date",
    labels: ["due date", "date due", "payment due", "payment due date", "due", "due by", "pay by"],
    kind: "date",
    core: true,
    prefer: "first",
  },
  {
    key: "po_number",
    name: "PO number",
    labels: ["po", "po #", "po no", "po number", "p o", "purchase order", "purchase order #", "purchase order no", "purchase order number"],
    kind: "id",
    core: false,
    prefer: "first",
  },
  {
    key: "bill_to",
    name: "Bill to",
    labels: ["bill to", "billed to", "billing address", "invoice to", "sold to", "customer"],
    kind: "block",
    core: false,
    prefer: "first",
  },
  {
    key: "subtotal",
    name: "Subtotal",
    labels: ["subtotal", "sub total", "sub-total", "invoice subtotal", "net", "net amount", "net total", "amount before tax", "total before tax"],
    kind: "money",
    core: true,
    prefer: "last",
  },
  {
    key: "tax",
    name: "Tax",
    labels: [
      "tax", "taxes", "sales tax", "total tax", "tax total", "tax amount", "vat", "gst", "hst", "pst", "qst",
      "gst/hst", "tva", "tps", "tvq", "tvh",
    ],
    kind: "money",
    core: true,
    prefer: "last",
    sum: true,
  },
  {
    key: "shipping",
    name: "Shipping",
    labels: ["shipping", "shipping & handling", "shipping and handling", "delivery", "freight", "postage"],
    kind: "money",
    core: false,
    prefer: "last",
  },
  {
    key: "discount",
    name: "Discount",
    labels: ["discount", "discounts", "promotion", "coupon"],
    kind: "money",
    core: false,
    prefer: "last",
  },
  {
    key: "total",
    name: "Total",
    labels: [
      "total", "grand total", "amount due", "balance due", "total due", "total payable", "amount payable",
      "total amount", "invoice total", "total to pay", "amount to pay", "balance",
    ],
    kind: "money",
    core: true,
    prefer: "last",
  },
];

/** Labels of the lines that close a list of items: from the first of these on, it's totals and payment. */
function closingLabels(fields: FieldSpec[]): Set<string> {
  return new Set(
    fields
      .filter((field) => ["subtotal", "tax", "total", "discount"].includes(field.key))
      .flatMap((field) => field.labels.map(normalizeLabel))
  );
}

/** Header words that say a table lists what was bought. */
const ITEM_HEADER = /\b(description|item|items|product|service|details|article|qty|quantity|unit|price|rate|hours)\b/i;
const AMOUNT_HEADER = /\b(amount|total|subtotal|line total|price|sous-total)\b/i;
const QUANTITY_HEADER = /\b(qty|quantity|quantité|hours|units)\b/i;

/**
 * Words that name the document rather than whoever sent it, so the vendor
 * guess passes over a big "INVOICE" at the top of the page.
 */
const DOCUMENT_WORDS = /\b(invoice|receipt|facture|statement|bill|paid|payé|page|tax|copy|original|quote|estimate)\b/i;

/** Amounts within a cent are equal: a document rounds each line, not the sum. */
const TOLERANCE = 0.011;

export const INVOICE: DocumentType = {
  id: "invoice",
  name: "invoice / receipt",
  defaultTemplate: DEFAULT_INVOICE_TEMPLATE,
  fields: FIELDS,
  read(pages: LayoutPage[], order: DateOrder, extraLabels: Record<string, string[]> = {}): TypedResult {
    // A user's own labels count exactly like the built-in ones.
    const fields = FIELDS.map((field) => ({ ...field, labels: [...field.labels, ...(extraLabels[field.key] ?? [])] }));
    const closing = closingLabels(fields);
    const found = findFields(pages, fields, order);
    const guessed: string[] = [];
    const warnings: string[] = [];

    if (!found.has("vendor")) {
      const vendor = guessVendor(pages);
      if (vendor) {
        found.set("vendor", vendor);
        guessed.push("vendor");
      }
    }
    if (!found.has("invoice_date")) {
      const date = firstDate(pages, order);
      if (date) {
        found.set("invoice_date", date);
        guessed.push("invoice_date");
      }
    }

    const items = lineItems(pages, closing);
    for (const problem of [items ? checkItems(items, found) : null, checkSum(found)]) {
      if (problem) warnings.push(problem);
    }

    const values: Record<string, string | number | null> = {};
    for (const spec of fields) {
      const value = found.get(spec.key)?.value;
      values[spec.key] = !value ? null : value.kind === "money" ? value.amount : value.kind === "date" ? value.iso : value.text;
    }
    const money = ["total", "subtotal", "tax"].map((key) => found.get(key)?.value).find((value) => value?.kind === "money" && value.currency);
    values.currency = money?.kind === "money" ? money.currency : null;

    const missing = fields.filter((spec) => spec.core && !found.has(spec.key)).map((spec) => spec.key);
    if (values.currency === null && found.has("total")) missing.push("currency");
    if (!items) missing.push("line_items");

    return {
      fields: values,
      blocks: { line_items: items ? items.markdown.join("\n") : "" },
      missing,
      ocr: [...found].filter(([, field]) => field.ocr).map(([key]) => key),
      guessed,
      ambiguous: [...found].filter(([, field]) => field.value.kind === "date" && field.value.ambiguous).map(([key]) => key),
      warnings,
    };
  },
};

/**
 * The vendor when no label names it: the most prominent line near the top
 * of the first page — the largest type, or the first line when it's all one
 * size, as on a till receipt — passing over the document's own title.
 */
function guessVendor(pages: LayoutPage[]): FoundField | null {
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
    .filter(({ run }) => /\p{L}{2}/u.test(run.text) && !DOCUMENT_WORDS.test(run.text) && !run.text.includes(":"));
  if (runs.length === 0) return null;
  const largest = Math.max(...runs.map(({ run }) => run.size));
  const chosen = runs.find(({ run }) => run.size >= largest * 0.95) ?? runs[0];
  return { value: { kind: "text", text: chosen.run.text }, label: "", ocr: page.source === "ocr", page: page.page, y: chosen.y };
}

/** The first date near the top of the first page, for a receipt that prints one with no label. */
function firstDate(pages: LayoutPage[], order: DateOrder): FoundField | null {
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

interface LineItems {
  markdown: string[];
  /** The amounts of the item rows, from the column that totals them. */
  amounts: number[];
  /** That column's header, for the conversion notes. */
  column: string;
}

/**
 * The table listing what was bought: the one whose header reads like it —
 * description, quantity, price — or failing that, as on a till receipt with
 * no header at all, the largest table that isn't mostly totals. Rows from
 * the first subtotal or total on are left out of the sum: they're the
 * totals, and on a receipt the payment.
 */
function lineItems(pages: LayoutPage[], closing: Set<string>): LineItems | null {
  const tables = pages.flatMap((page) => page.tables);
  const score = (found: DetectedTable) => found.rows[0].filter((cell) => ITEM_HEADER.test(cell)).length;
  const headedTables = tables.filter((found) => score(found) > 0);
  const chosen =
    headedTables.sort((a, b) => score(b) - score(a) || b.rows.length - a.rows.length)[0] ??
    tables
      .filter((found) => found.rows.filter((row) => isClosing(row[0], closing)).length < found.rows.length / 2)
      .sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!chosen) return null;
  const headed = score(chosen) > 0;

  const body = headed ? chosen.rows.slice(1) : chosen.rows;
  const end = body.findIndex((row) => isClosing(row[0], closing));
  const items = end === -1 ? body : body.slice(0, end);

  // The column the items add up in: under a header, the one headed like
  // an amount and holding numbers — never a guess, since a quantity column
  // is numbers too. Without a header, as on a till receipt, the last
  // column of numbers.
  let column = -1;
  if (headed) {
    chosen.rows[0].forEach((cell, index) => {
      if (AMOUNT_HEADER.test(cell) && !QUANTITY_HEADER.test(cell) && chosen.numeric[index]) column = index;
    });
  } else {
    column = chosen.numeric.lastIndexOf(true);
  }
  const amounts = column === -1 ? [] : items.map((row) => parseMoney(row[column] ?? "")?.amount).filter((amount): amount is number => amount !== undefined);

  return {
    markdown: table(
      chosen.rows.map((row) => row.map((cell) => squashSpaces(escapeInline(cell)))),
      chosen.numeric
    ),
    amounts,
    column: headed && column !== -1 ? chosen.rows[0][column] : "the amount column",
  };
}

function isClosing(cell: string, closing: Set<string>): boolean {
  return closing.has(normalizeLabel(cell)) || cell.split(/\s+\/\s+/).some((half) => closing.has(normalizeLabel(half)));
}

/** The line items should add up to the subtotal — or the total, when there's no subtotal and no tax. */
function checkItems(items: LineItems, found: Map<string, FoundField>): string | null {
  if (items.amounts.length === 0) return null;
  const sum = round(items.amounts.reduce((total, amount) => total + amount, 0));
  const against = found.has("subtotal") ? "subtotal" : !found.has("tax") && found.has("total") ? "total" : null;
  if (!against) return null;
  const expected = moneyOf(found, against) as number;
  if (Math.abs(sum - expected) <= TOLERANCE) return null;
  return (
    `The line items (${escapeInline(items.column)}) add up to ${format(sum)}, but the ${against} is ` +
    `${format(expected)} — check both against the original.`
  );
}

/** Subtotal, plus tax and shipping, less any discount, should be the total. */
function checkSum(found: Map<string, FoundField>): string | null {
  const subtotal = moneyOf(found, "subtotal");
  const tax = moneyOf(found, "tax");
  const total = moneyOf(found, "total");
  if (subtotal === null || tax === null || total === null) return null;
  const shipping = moneyOf(found, "shipping") ?? 0;
  // Printed either way: "Discount −11.30" or "Discount 11.30". Either way it comes off.
  const discount = Math.abs(moneyOf(found, "discount") ?? 0);
  const expected = round(subtotal + tax + shipping - discount);
  if (Math.abs(expected - total) <= TOLERANCE) return null;
  const parts = [
    `subtotal ${format(subtotal)}`,
    `tax ${format(tax)}`,
    ...(shipping ? [`shipping ${format(shipping)}`] : []),
    ...(discount ? [`less discount ${format(discount)}`] : []),
  ];
  return `${parts.join(", ")} come to ${format(expected)}, but the total is ${format(total)} — check the figures against the original.`;
}

function moneyOf(found: Map<string, FoundField>, key: string): number | null {
  const value = found.get(key)?.value;
  return value?.kind === "money" ? value.amount : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function format(value: number): string {
  return value.toFixed(2);
}
