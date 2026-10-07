/**
 * Reading the values a document type pulls out — amounts and dates — from
 * the text they were printed as.
 *
 * Both are written in more ways than a single pattern covers: `$1,469.00 CAD`,
 * `−$11.30`, `(45.00)`, `1.234,56 €`; `05 October 2026`, `Oct. 6, 2026`,
 * `2026-10-06`, `06/10/2026`. Each is normalised to one form a note property
 * can be sorted and summed by: a plain number, and an ISO date.
 */

export interface Money {
  amount: number;
  /** The ISO code printed beside the amount, or the symbol when there's no code. */
  currency: string | null;
}

/**
 * Symbols that name exactly one currency. `$` names a dozen, so it's kept as
 * printed rather than guessed into USD or CAD.
 */
const SYMBOLS: Record<string, string> = { "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };

const MONEY =
  /([-−–(]?)\s*([$€£¥₹]|\b[A-Z]{3}\b)?\s*([-−–]?)\s*(\d{1,3}(?:[,.'  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(\)?)\s*([$€£¥₹]|\b[A-Z]{3}\b)?/;

/** A rate, which is never an amount: the 13% in `HST (13%)`. */
const PERCENTAGE = /\d+(?:[.,]\d+)?\s*%/g;

/** The first amount in a value, or null when there's none. */
export function parseMoney(text: string): Money | null {
  const match = MONEY.exec(text.replace(PERCENTAGE, " "));
  if (!match) return null;
  const [, sign, before, innerSign, digits, close, after] = match;

  const amount = numberFrom(digits);
  if (amount === null) return null;
  const negative = sign === "(" ? close === ")" : sign !== "" || innerSign !== "";
  const mark = after ?? before ?? null;
  return { amount: negative ? -amount : amount, currency: mark ? (SYMBOLS[mark] ?? mark) : null };
}

/**
 * Digits with their grouping and decimal marks resolved. Where both marks
 * appear, whichever comes last is the decimal point (`1,234.56`, `1.234,56`);
 * a lone mark followed by exactly two digits is a decimal point too, since
 * nobody groups thousands in twos.
 */
function numberFrom(digits: string): number | null {
  const compact = digits.replace(/['\s ]/g, "");
  const lastComma = compact.lastIndexOf(",");
  const lastDot = compact.lastIndexOf(".");
  let normal: string;
  if (lastComma !== -1 && lastDot !== -1) {
    const decimal = lastComma > lastDot ? "," : ".";
    normal = compact.replace(decimal === "," ? /\./g : /,/g, "").replace(",", ".");
  } else if (lastComma !== -1) {
    normal = /,\d{1,2}$/.test(compact) && compact.split(",").length === 2 ? compact.replace(",", ".") : compact.replace(/,/g, "");
  } else if (lastDot !== -1 && compact.split(".").length > 2) {
    normal = compact.replace(/\./g, "");
  } else {
    normal = compact;
  }
  const value = Number(normal);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

export type DateOrder = "dmy" | "mdy";

export interface ParsedDate {
  iso: string;
  /** All-number and readable either way round: `06/10/2026`. Decided by the date order setting. */
  ambiguous: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(\\d{4})";

const ISO_DATE = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/;
const DAY_MONTH_YEAR = new RegExp(`\\b${DAY}\\s+${MONTH},?\\s+${YEAR}\\b`, "i");
const MONTH_DAY_YEAR = new RegExp(`\\b${MONTH}\\s+${DAY},?\\s+${YEAR}\\b`, "i");
const NUMERIC_DATE = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/;

/** The first date in a value, or null when there's none. */
export function parseDate(text: string, order: DateOrder): ParsedDate | null {
  let match = ISO_DATE.exec(text);
  if (match) return dated(+match[1], +match[2], +match[3], false);

  match = DAY_MONTH_YEAR.exec(text);
  if (match) return dated(+match[3], monthNumber(match[2]), +match[1], false);

  match = MONTH_DAY_YEAR.exec(text);
  if (match) return dated(+match[3], monthNumber(match[1]), +match[2], false);

  match = NUMERIC_DATE.exec(text);
  if (match) {
    const [first, second] = [+match[1], +match[2]];
    const year = match[3].length === 2 ? 2000 + +match[3] : +match[3];
    // A part over twelve can only be the day, whatever the setting says.
    if (first > 12) return dated(year, second, first, false);
    if (second > 12) return dated(year, first, second, false);
    const ambiguous = first !== second;
    return order === "dmy" ? dated(year, second, first, ambiguous) : dated(year, first, second, ambiguous);
  }
  return null;
}

function monthNumber(name: string): number {
  return MONTHS[name.toLowerCase().replace(/\.$/, "")] ?? 0;
}

function dated(year: number, month: number, day: number, ambiguous: boolean): ParsedDate | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || date.getUTCDate() !== day) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return { iso: `${year}-${pad(month)}-${pad(day)}`, ambiguous };
}
