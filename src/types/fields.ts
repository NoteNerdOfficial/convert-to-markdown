import { LayoutPage } from "../layout/page";
import { Run, runsOf } from "../layout/tables";
import { DateOrder, parseDate, parseMoney } from "./values";

/**
 * Finding a document's fields — the value printed beside *Invoice date*, the
 * address under *Bill to* — from the page as it was laid out.
 *
 * There's no understanding here, only labels and positions. A field is a
 * list of the labels documents print for it, and a value is found where a
 * label's value is found in practice:
 *
 * - **inline**: `Invoice #: 1042`, or `Amount due $1,469.00` with no colon;
 * - **beside**: the label, then the value set apart on the same line — or
 *   centred against a label that wraps onto two, so just above or below it;
 * - **below**: the label, then the value on the lines under it.
 *
 * Labels are matched whole, never as part of a longer label, so *Tax* doesn't
 * match *Tax Registrations* and *Total* doesn't match *Subtotal*. A label
 * printed in two languages (`Invoice date / Date de facturation`) matches on
 * either. When a field's labels turn up more than once, the most specific
 * label wins — *Total payable* over a table's bare *Total* — then the most
 * direct layout, then position.
 */

export type FieldKind = "text" | "id" | "money" | "date" | "block";

export interface FieldSpec {
  key: string;
  /** As shown in settings. */
  name: string;
  /** Labels as printed, matched case-insensitively and whole. */
  labels: string[];
  kind: FieldKind;
  /** Expected on every document of the type, and so named in `missing_fields` when not found. */
  core: boolean;
  /** Which occurrence wins a tie: totals sit at the bottom, numbers at the top. */
  prefer: "first" | "last";
  /** Several equally good matches on different lines are added up — GST and PST. */
  sum?: boolean;
}

export type FieldValue = { kind: "text"; text: string } | { kind: "money"; amount: number; currency: string | null } | { kind: "date"; iso: string; ambiguous: boolean };

export interface FoundField {
  value: FieldValue;
  /** The label it was found by, as printed. */
  label: string;
  /** Read by OCR rather than extracted, and so possibly misread. */
  ocr: boolean;
  /** Where on the page, for telling fields apart from tables. */
  page: number;
  y: number;
}

/** How much a layout says about which value a label means. */
const INLINE = 3;
const BESIDE = 2;
const BELOW = 1;

/** Runs closer than this many ems are one stretch of text. */
const RUN_GAP = 1;

/** A label longer than this many words is a sentence with a colon in it. */
const MAX_LABEL_WORDS = 8;

/** How far below a label, in line heights, its value can start. */
const BELOW_REACH = 2.4;

interface Candidate {
  found: FoundField;
  score: number;
  layout: number;
  row: number;
}

/** The best value for each field, by key. Fields not found are absent. */
export function findFields(pages: LayoutPage[], specs: FieldSpec[], order: DateOrder): Map<string, FoundField> {
  const candidates = new Map<string, Candidate[]>();
  const labelSets = specs.map((spec) => ({ spec, labels: new Map(spec.labels.map((label) => [normalizeLabel(label), label])) }));
  const isAnyLabel = (text: string) => labelSets.some(({ labels }) => alternatives(text).some((alt) => labels.has(alt)));

  for (const page of pages) {
    const rows = page.rows.map((row) => runsOf(row, RUN_GAP));
    rows.forEach((runs, rowIndex) => {
      runs.forEach((run, runIndex) => {
        for (const { spec, labels } of labelSets) {
          for (const match of labelMatches(run.text, labels)) {
            const add = (raw: string, layout: number, y: number) => {
              const value = valueOf(spec, raw, order);
              if (!value) return false;
              const list = candidates.get(spec.key) ?? [];
              list.push({
                found: { value, label: match.label, ocr: page.source === "ocr", page: page.page, y },
                score: match.words,
                layout,
                row: rowIndex,
              });
              candidates.set(spec.key, list);
              return true;
            };
            const y = page.rows[rowIndex].y;
            if (match.rest !== "" && add(cutAtNextLabel(match.rest), INLINE, y)) continue;
            if (match.rest !== "") continue;
            const beside = runs[runIndex + 1] ?? besideAcross(rows, page, rowIndex, run);
            if (beside && !isAnyLabel(beside.text) && add(beside.text, BESIDE, y)) continue;
            const below = linesBelow(rows, page, rowIndex, run, spec.kind === "block", isAnyLabel);
            if (below.length > 0) add(below.join(spec.kind === "block" ? ", " : " "), BELOW, y);
          }
        }
      });
    });
  }

  const found = new Map<string, FoundField>();
  for (const spec of specs) {
    const list = candidates.get(spec.key);
    if (!list || list.length === 0) continue;
    const best = pick(list, spec);
    found.set(spec.key, best);
  }
  return found;
}

/**
 * The winning candidate: most specific label, then most direct layout, then
 * position. Where a field adds up and several equally good matches sit on
 * different lines, the result is their sum.
 */
function pick(list: Candidate[], spec: FieldSpec): FoundField {
  const position = (candidate: Candidate) => candidate.found.page * 1e6 + candidate.found.y;
  const ranked = [...list].sort(
    (a, b) =>
      b.score - a.score ||
      b.layout - a.layout ||
      (spec.prefer === "last" ? position(b) - position(a) : position(a) - position(b))
  );
  const best = ranked[0];
  if (!spec.sum || best.found.value.kind !== "money") return best.found;

  const peers = ranked.filter(
    (candidate) => candidate.score === best.score && candidate.layout === best.layout && candidate.found.value.kind === "money"
  );
  const lines = new Map(peers.map((candidate) => [`${candidate.found.page}:${candidate.row}`, candidate]));
  if (lines.size < 2) return best.found;
  const parts = [...lines.values()];
  const amount = parts.reduce((total, part) => total + (part.found.value as { amount: number }).amount, 0);
  return {
    ...best.found,
    value: { kind: "money", amount: Math.round(amount * 100) / 100, currency: (best.found.value as { currency: string | null }).currency },
    label: parts.map((part) => part.found.label).join(" + "),
    ocr: parts.some((part) => part.found.ocr),
  };
}

interface LabelMatch {
  /** The label as printed. */
  label: string;
  /** How many words the matched label has: the more, the more specific. */
  words: number;
  /** What follows the label in the same run, if anything. */
  rest: string;
}

/**
 * The ways a run of text can start with one of a field's labels: everything
 * before a colon, or its first few words with a value after them.
 */
function labelMatches(text: string, labels: Map<string, string>): LabelMatch[] {
  const matches: LabelMatch[] = [];
  const colon = text.search(/:(\s|$)/);
  if (colon > 0) {
    const label = text.slice(0, colon);
    const matched = alternatives(label).find((alt) => labels.has(alt));
    if (matched && label.split(/\s+/).length <= MAX_LABEL_WORDS) {
      return [{ label: label.trim(), words: matched.split(" ").length, rest: text.slice(colon + 1).trim() }];
    }
  }
  const words = text.split(/\s+/);
  for (let count = Math.min(words.length, MAX_LABEL_WORDS); count >= 1; count--) {
    const label = words.slice(0, count).join(" ");
    // Labels don't have amounts in them (a rate in brackets, as in "HST
    // (13%)", is dropped by normalising). Without this, the second half of a
    // bilingual label could run on into the value: "Total partiel de la
    // $27.34" read as the French label, with nothing left to be its value.
    if (/\d/.test(normalizeLabel(label))) continue;
    const matched = alternatives(label).find((alt) => labels.has(alt));
    if (matched) matches.push({ label, words: matched.split(" ").length, rest: words.slice(count).join(" ") });
  }
  return matches;
}

/**
 * A label's normal form: lower case, without the percentages, notes and
 * trailing punctuation that vary from one document to the next (`HST
 * (13%)`, `Invoice No.:`), with the ways of writing "number" made one.
 */
export function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(?:n[°º]|no\.|num\.?|nr\.?)(?=\s|$)/g, "no")
    .replace(/\s*#\s*/g, " # ")
    .replace(/[:.\s]+$/, "")
    .replace(/[^\p{L}\p{N}#&/ -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A bilingual label's halves, each normalised: `Invoice date / Date de facturation`. */
function alternatives(label: string): string[] {
  return [normalizeLabel(label), ...label.split(/\s+\/\s+/).map(normalizeLabel)].filter((alt) => alt !== "");
}

/**
 * A value that runs on into the next label on the same line — `77810 PO:
 * 4471-B` — cut where that label starts.
 */
function cutAtNextLabel(text: string): string {
  const next = /\s+[\p{L}#][\p{L}#.\s]{0,24}:\s/u.exec(text);
  return (next ? text.slice(0, next.index) : text).trim();
}

/**
 * A value to the right of a label but not on its baseline: set centred
 * against a label that wraps onto a second line, it sits between the two.
 * The nearest run to the label's right on the lines just above and below.
 */
function besideAcross(rows: Run[][], page: LayoutPage, labelRow: number, label: Run): Run | undefined {
  const y = page.rows[labelRow].y;
  let best: Run | undefined;
  for (const index of [labelRow - 1, labelRow + 1]) {
    if (index < 0 || index >= rows.length || Math.abs(page.rows[index].y - y) > label.size) continue;
    for (const run of rows[index]) {
      if (run.left > label.right && (!best || run.left < best.left)) best = run;
    }
  }
  return best;
}

/**
 * The text under a label: the runs in the lines just below it that line up
 * with it. A block field (an address) takes every line until a gap or
 * another label; any other field takes the first.
 */
function linesBelow(
  rows: Run[][],
  page: LayoutPage,
  labelRow: number,
  label: Run,
  block: boolean,
  isAnyLabel: (text: string) => boolean
): string[] {
  const out: string[] = [];
  let lastY = page.rows[labelRow].y;
  for (let index = labelRow + 1; index < rows.length; index++) {
    const y = page.rows[index].y;
    if (y - lastY > BELOW_REACH * label.size) break;
    const under = rows[index].find(
      (run) => run.left < label.right + label.size && run.right > label.left - label.size && Math.abs(run.left - label.left) <= 2 * label.size
    );
    if (!under || isAnyLabel(under.text)) break;
    out.push(under.text);
    lastY = y;
    if (!block) break;
  }
  return out;
}

function valueOf(spec: FieldSpec, raw: string, order: DateOrder): FieldValue | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  switch (spec.kind) {
    case "money": {
      const money = parseMoney(text);
      return money ? { kind: "money", amount: money.amount, currency: money.currency } : null;
    }
    case "date": {
      const date = parseDate(text, order);
      return date ? { kind: "date", iso: date.iso, ambiguous: date.ambiguous } : null;
    }
    case "id": {
      // An identifier is one token, and has a digit in it somewhere; "Invoice
      // # Date" in a table header isn't a number.
      const token = text.split(" ")[0].replace(/[,;]$/, "");
      return /\d/.test(token) ? { kind: "text", text: token } : null;
    }
    default:
      return parseMoney(text) && /^[\d\s$€£.,()−-]+$/.test(text) ? null : { kind: "text", text };
  }
}
