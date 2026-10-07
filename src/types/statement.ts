import { LayoutPage } from "../layout/page";
import { DetectedTable } from "../layout/tables";
import { escapeInline, squashSpaces, table } from "../markdown";
import { FieldSpec, findFields, FoundField } from "./fields";
import { format, moneyOf, prominentLine, round, TOLERANCE } from "./shared";
import { DocumentType, TypedResult } from "./types";
import { DateOrder, parseDate, parseMoney } from "./values";

/** The built-in statement template, used when no template note is set. */
export const DEFAULT_STATEMENT_TEMPLATE = `---
type: statement
institution: {{institution}}
account_last4: {{account_last4}}
period_start: {{period_start}}
period_end: {{period_end}}
opening_balance: {{opening_balance}}
closing_balance: {{closing_balance}}
currency: {{currency}}
tags: [finance, statements]
---
{{original}}

{{content}}
`;

const FIELDS: FieldSpec[] = [
  {
    key: "institution",
    name: "Institution",
    labels: ["bank", "institution", "issuer", "card issuer"],
    kind: "text",
    core: true,
    prefer: "first",
  },
  {
    key: "account",
    name: "Account number",
    labels: [
      "account", "account number", "account #", "account no", "account ending", "account ending in", "acct", "acct #",
      "acct no", "card number", "card #", "card no", "card ending", "card ending in", "iban",
    ],
    kind: "account",
    core: true,
    prefer: "first",
  },
  {
    key: "period",
    name: "Statement period",
    labels: ["statement period", "period", "billing period", "statement dates", "for the period", "period covered"],
    kind: "text",
    core: true,
    prefer: "first",
  },
  {
    key: "statement_date",
    name: "Statement date",
    labels: ["statement date", "closing date", "statement closing date", "as of", "as at"],
    kind: "date",
    core: false,
    prefer: "first",
  },
  {
    key: "opening_balance",
    name: "Opening balance",
    labels: [
      "opening balance", "previous balance", "balance forward", "beginning balance", "starting balance",
      "balance brought forward", "previous statement balance", "balance at start",
    ],
    kind: "money",
    core: true,
    prefer: "first",
  },
  {
    key: "closing_balance",
    name: "Closing balance",
    labels: [
      "closing balance", "new balance", "ending balance", "balance at end", "statement balance", "current balance",
      "balance carried forward", "new statement balance",
    ],
    kind: "money",
    core: true,
    prefer: "last",
  },
];

/** Words that name the document rather than who issued it. */
const DOCUMENT_WORDS = /\b(statement|account|page|summary|monthly|chequing|checking|savings|relevé)\b/i;

/** Header words that say a table lists transactions. */
const TRANSACTION_HEADER = /\b(date|description|details|transaction|withdrawals?|deposits?|debits?|credits?|amount|balance)\b/i;
const MONEY_OUT = /\b(withdrawals?|debits?|paid out|money out|charges|purchases|retraits?)\b/i;
const MONEY_IN = /\b(deposits?|credits?|paid in|money in|payments?|dépôts?)\b/i;
const AMOUNT = /\b(amount|montant)\b/i;
const BALANCE = /\b(balance|solde)\b/i;

export const STATEMENT: DocumentType = {
  id: "statement",
  name: "statement",
  defaultTemplate: DEFAULT_STATEMENT_TEMPLATE,
  fields: FIELDS,
  read(pages: LayoutPage[], order: DateOrder, extraLabels: Record<string, string[]> = {}): TypedResult {
    const fields = FIELDS.map((field) => ({ ...field, labels: [...field.labels, ...(extraLabels[field.key] ?? [])] }));
    const found = findFields(pages, fields, order);
    const guessed: string[] = [];
    const ambiguous: string[] = [];
    const warnings: string[] = [];

    if (!found.has("institution")) {
      const institution = prominentLine(pages, DOCUMENT_WORDS) ?? titleLine(pages);
      if (institution) {
        found.set("institution", institution);
        guessed.push("institution");
      }
    }

    // A statement period is two dates in one value: "Sep 1, 2026 to Sep 30, 2026".
    const period = found.get("period");
    const dates = period?.value.kind === "text" ? periodDates(period.value.text, order) : [];
    const statementDate = found.get("statement_date")?.value;
    const values: Record<string, string | number | null> = {
      institution: textOf(found.get("institution")),
      account_last4: lastFour(found.get("account")),
      period_start: dates[0]?.iso ?? null,
      period_end: dates[1]?.iso ?? (statementDate?.kind === "date" ? statementDate.iso : null),
      opening_balance: moneyOf(found, "opening_balance"),
      closing_balance: moneyOf(found, "closing_balance"),
      currency: null,
    };
    if (dates.some((date) => date.ambiguous)) ambiguous.push("period_start", "period_end");
    const money = ["closing_balance", "opening_balance"].map((key) => found.get(key)?.value).find((value) => value?.kind === "money" && value.currency);
    values.currency = money?.kind === "money" ? money.currency : null;

    const transactions = transactionTable(pages);
    if (transactions) {
      const problem = checkTransactions(transactions, values.opening_balance as number | null, values.closing_balance as number | null);
      if (problem) warnings.push(...problem);
    }

    const missing = [
      ...["institution", "account_last4", "period_start", "period_end", "opening_balance", "closing_balance"].filter(
        (key) => values[key] === null
      ),
      ...(values.currency === null && values.closing_balance !== null ? ["currency"] : []),
      ...(transactions ? [] : ["transactions"]),
    ];
    const ocr = [...found].filter(([, field]) => field.ocr).map(([key]) => fieldKeyFor(key));

    return {
      fields: values,
      blocks: { transactions: transactions ? transactions.markdown.join("\n") : "" },
      missing,
      ocr: [...new Set(ocr.flat())],
      guessed,
      ambiguous,
      warnings,
    };
  },
};

/** The property keys a found field fills, for `ocr_fields`. */
function fieldKeyFor(key: string): string[] {
  if (key === "account") return ["account_last4"];
  if (key === "period") return ["period_start", "period_end"];
  if (key === "statement_date") return ["period_end"];
  return [key];
}

/**
 * When every line at the top is the document's own title — "Maple Bank —
 * Chequing Account Statement" — the issuer is its first part, before the
 * dash.
 */
function titleLine(pages: LayoutPage[]): FoundField | null {
  const line = prominentLine(pages, /(?!)/);
  if (!line || line.value.kind !== "text") return null;
  const [first] = line.value.text.split(/\s+[—–-]\s+/);
  return first && first !== line.value.text ? { ...line, value: { kind: "text", text: first.trim() } } : null;
}

function textOf(field: FoundField | undefined): string | null {
  return field?.value.kind === "text" ? field.value.text : null;
}

/**
 * The last four digits of an account or card number, and nothing more. A
 * note's properties get synced, searched and shown in lists; a full account
 * number has no business there, and the last four are what statements and
 * people identify an account by anyway.
 */
function lastFour(field: FoundField | undefined): string | null {
  if (field?.value.kind !== "text") return null;
  const digits = field.value.text.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** The two dates of a period, split at "to", "through" or a dash. */
function periodDates(text: string, order: DateOrder): { iso: string; ambiguous: boolean }[] {
  const parts = text.split(/\s+(?:to|through|thru|until|au|-|–|—)\s+/i);
  if (parts.length < 2) return [];
  const start = parseDate(parts[0], order);
  const end = parseDate(parts.slice(1).join(" "), order);
  return start && end ? [start, end] : [];
}

interface Transactions {
  markdown: string[];
  rows: string[][];
  out: number;
  in: number;
  amount: number;
  balance: number;
  date: number;
}

/**
 * The table of transactions: the one whose header reads like it — date,
 * description, withdrawals, deposits, balance. A statement that runs over
 * several pages repeats that header on each, and those tables are one.
 */
function transactionTable(pages: LayoutPage[]): Transactions | null {
  const tables = pages.flatMap((page) => page.tables);
  const score = (found: DetectedTable) => found.rows[0].filter((cell) => TRANSACTION_HEADER.test(cell)).length;
  const best = [...tables].sort((a, b) => score(b) - score(a) || b.rows.length - a.rows.length)[0];
  if (!best || score(best) < 2) return null;

  const header = best.rows[0];
  const same = tables.filter((found) => found.rows[0].join("|") === header.join("|"));
  const rows = [header, ...same.flatMap((found) => found.rows.slice(1))];
  const numeric = header.map((_, column) => same.some((found) => found.numeric[column]));
  const find = (pattern: RegExp) => header.findIndex((cell, index) => numeric[index] && pattern.test(cell));

  return {
    markdown: table(
      rows.map((row) => row.map((cell) => squashSpaces(escapeInline(cell)))),
      numeric
    ),
    rows: rows.slice(1),
    out: find(MONEY_OUT),
    in: find(MONEY_IN),
    amount: find(AMOUNT),
    balance: find(BALANCE),
    date: header.findIndex((cell) => /\bdate\b/i.test(cell)),
  };
}

/**
 * Two checks a statement makes possible.
 *
 * Every row against the running balance, where there's a balance column:
 * the balance before it, plus what came in, less what went out. Then the
 * whole period: the opening balance plus everything in, less everything
 * out, should be the closing balance.
 *
 * Which way an amount counts isn't the same on every statement. On a bank
 * account a credit is money in; on a credit card it's a payment that brings
 * the balance owed down, and a single "Amount" column might show purchases
 * as plus or as minus. So both readings are tried and the statement's own
 * figures decide: the one its balances agree with is right, and only when
 * neither does is anything reported.
 */
function checkTransactions(found: Transactions, opening: number | null, closing: number | null): string[] | null {
  const signed = (sign: 1 | -1) =>
    found.rows.map((row) => {
      if (found.amount !== -1) return sign * (amountIn(row[found.amount]) ?? 0);
      const inflow = found.in === -1 ? 0 : amountIn(row[found.in]) ?? 0;
      const outflow = found.out === -1 ? 0 : amountIn(row[found.out]) ?? 0;
      return sign * (inflow - outflow);
    });
  if (found.amount === -1 && found.in === -1 && found.out === -1) return null;

  const readings = ([1, -1] as const).map((sign) => {
    const changes = signed(sign);
    const wrongRows: number[] = [];
    if (found.balance !== -1) {
      const balances = found.rows.map((row) => amountIn(row[found.balance]));
      let previous = opening;
      balances.forEach((balance, index) => {
        if (balance === null) return;
        const expected = previous === null ? null : round(previous + changes[index]);
        previous = balance;
        if (expected === null || Math.abs(expected - balance) <= TOLERANCE) return;
        wrongRows.push(index);
        // One wrong figure shouldn't make every row after it look wrong.
        // If the next row follows from what this balance should have been,
        // it was the balance that was misprinted (or misread), and the check
        // carries on from the right one.
        const next = balances[index + 1];
        if (next !== null && next !== undefined && Math.abs(round(expected + changes[index + 1]) - next) <= TOLERANCE) {
          previous = expected;
        }
      });
    }
    const total = round(changes.reduce((sum, change) => sum + change, 0));
    const periodOk = opening === null || closing === null || Math.abs(round(opening + total) - closing) <= TOLERANCE;
    return { wrongRows, total, periodOk };
  });
  const [first, second] = readings;
  const chosen =
    first.wrongRows.length + (first.periodOk ? 0 : 1) <= second.wrongRows.length + (second.periodOk ? 0 : 1) ? first : second;

  const problems: string[] = [];
  if (chosen.wrongRows.length > 0) {
    const named = chosen.wrongRows.slice(0, 8).map((index) => {
      const row = found.rows[index];
      const date = found.date !== -1 ? row[found.date] : "";
      return escapeInline([date, row.find((cell, column) => column !== found.date && /\p{L}/u.test(cell)) ?? ""].filter(Boolean).join(" "));
    });
    problems.push(
      `The running balance doesn't follow from the transactions on ${chosen.wrongRows.length} row` +
        `${chosen.wrongRows.length === 1 ? "" : "s"}: ${named.join("; ")}${chosen.wrongRows.length > 8 ? "; …" : ""} — ` +
        "check them against the original."
    );
  }
  if (!chosen.periodOk && opening !== null && closing !== null) {
    problems.push(
      `The opening balance ${format(opening)} and the transactions (${format(chosen.total)}) come to ` +
        `${format(round(opening + chosen.total))}, but the closing balance is ${format(closing)} — check the figures against the original.`
    );
  }
  return problems.length > 0 ? problems : null;
}

function amountIn(cell: string | undefined): number | null {
  return cell ? (parseMoney(cell)?.amount ?? null) : null;
}
