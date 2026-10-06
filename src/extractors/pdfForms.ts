import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { escapeInline, heading, table } from "../markdown";

/**
 * What a fillable PDF's fields hold, ready to go into the note.
 *
 * Everything is empty for a PDF with no AcroForm, so the caller can splice it
 * in unconditionally and a plain PDF converts exactly as it did before.
 */
export interface FormFields {
  /** A `## Form fields` table, to go before the page text. */
  lines: string[];
  warnings: string[];
  frontmatter: Record<string, string>;
}

const NO_FORM: FormFields = { lines: [], warnings: [], frontmatter: {} };

/**
 * One entry of `getFieldObjects()`. pdf.js types these as `Object`; this is
 * the subset its widget classes actually fill in.
 */
interface FieldObject {
  id: string;
  type: string;
  value?: unknown;
  exportValues?: unknown;
  page?: number;
  rect?: number[];
  items?: { exportValue: string; displayValue: string }[];
}

interface Field {
  name: string;
  label: string;
  type: string;
  widgets: FieldObject[];
}

/**
 * Reads a fillable form's fields and what was entered in them.
 *
 * Unlike everything else in the PDF extractor this involves no reconstruction:
 * an AcroForm stores each field's name and value as data, so the table is
 * exact. The page text still carries the form's printed labels; this is what
 * was typed into it, which the text layer doesn't contain at all.
 *
 * An unticked checkbox counts as not filled in. A form can't tell "no" apart
 * from "didn't answer", and a blank form is all unticked boxes — but those
 * are reported apart from the empty text fields, so they don't read as
 * missing data.
 */
export async function readFormFields(document: PDFDocumentProxy): Promise<FormFields> {
  const objects = (await document.getFieldObjects()) as Record<string, FieldObject[]> | null;
  if (!objects) return NO_FORM;

  const details = await widgetDetails(document);
  const fields: Field[] = [];
  const signatures: Field[] = [];
  for (const [name, entries] of Object.entries(objects)) {
    // A field split across several widgets — a radio group, or a text field
    // repeated on every page — has a parent entry with no type of its own,
    // and one entry per widget that carries the value.
    const widgets = entries.filter((entry) => entry.type !== "");
    const type = widgets[0]?.type;
    const label = details.labels.get(name) || name;
    // A push button is an action, not an answer.
    if (type === undefined || type === "button") continue;
    // pdf.js doesn't report whether a signature field holds a signature, so
    // there's no value to show — only the fact that the field exists.
    (type === "signature" ? signatures : fields).push({ name, label, type, widgets });
  }
  if (fields.length === 0 && signatures.length === 0) return NO_FORM;
  disambiguate([...fields, ...signatures]);

  const rows = inReadingOrder(fields).map((field) => ({ field, value: valueOf(field, details.selections) }));
  const filled = rows.filter((row) => row.value.filled);

  const warnings: string[] = [];
  if (fields.length > 0 && filled.length === 0) {
    warnings.push(`The form is blank — none of its ${fields.length} fields are filled in.`);
  } else {
    // Named, not counted: which fields were left empty is what someone
    // checking a returned form needs to chase.
    const empty = rows.filter((row) => !row.value.filled && row.field.type !== "checkbox");
    const unticked = rows.filter((row) => !row.value.filled && row.field.type === "checkbox");
    if (empty.length > 0) warnings.push(`Form fields left empty: ${nameList(empty.map((row) => row.field.label))}.`);
    if (unticked.length > 0) {
      warnings.push(`Checkboxes left unticked: ${nameList(unticked.map((row) => row.field.label))}.`);
    }
  }
  if (signatures.length > 0) {
    warnings.push(
      `Signature fields aren't read, so whether ${signatures.length === 1 ? "this one is" : "these are"} signed ` +
        `isn't shown: ${nameList(signatures.map((field) => field.label))}.`
    );
  }

  return {
    lines:
      fields.length > 0
        ? [
            "",
            heading(2, "Form fields"),
            "",
            ...table([["Field", "Value"], ...rows.map((row) => [escapeInline(row.field.label), row.value.text])]),
            "",
          ]
        : [],
    warnings,
    frontmatter: fields.length > 0 ? { form_fields_filled: `${filled.length}/${fields.length}` } : {},
  };
}

/**
 * Forms reuse a tooltip for each repeat of a section — three "Name" fields, one
 * per contact — and a list of empty fields reading "Name, Name" doesn't say
 * which. Those get the field's own name alongside.
 */
function disambiguate(fields: Field[]): void {
  const counts = new Map<string, number>();
  for (const field of fields) counts.set(field.label, (counts.get(field.label) ?? 0) + 1);
  for (const field of fields) {
    if ((counts.get(field.label) ?? 0) > 1 && field.label !== field.name) field.label = `${field.label} (${field.name})`;
  }
}

/** What the page annotations know about the fields that the field objects don't. */
interface WidgetDetails {
  /**
   * Each field's tooltip (`/TU`), which is the form designer's human-readable
   * name for it — "Date of birth" where the field itself is called `dob_1`.
   */
  labels: Map<string, string>;
  /**
   * Every selection in a choice field, by widget id. Its field object only
   * carries the first, which loses the rest of a multi-select list box.
   */
  selections: Map<string, unknown[]>;
}

/**
 * Read from the pages' widget annotations, since `getFieldObjects()` doesn't
 * return either. Only done for a PDF that has a form, so a plain PDF never
 * pays for it.
 */
async function widgetDetails(document: PDFDocumentProxy): Promise<WidgetDetails> {
  const labels = new Map<string, string>();
  const selections = new Map<string, unknown[]>();
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    for (const annotation of await page.getAnnotations()) {
      const name = annotation.fieldName as unknown;
      const label = squashLabel(annotation.alternativeText);
      if (typeof name === "string" && label && !labels.has(name)) labels.set(name, label);
      if (Array.isArray(annotation.fieldValue)) selections.set(String(annotation.id), annotation.fieldValue);
    }
  }
  return { labels, selections };
}

function squashLabel(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

interface FieldValue {
  text: string;
  filled: boolean;
}

function valueOf(field: Field, selections: Map<string, unknown[]>): FieldValue {
  const widgets = field.widgets;
  switch (field.type) {
    case "checkbox": {
      const ticked = widgets.find((widget) => isOn(widget.value));
      // Several checkboxes sharing a name behave like a radio group, and then
      // which one is ticked is the answer, not just that one is.
      const exports = new Set(widgets.map((widget) => widget.exportValues));
      if (exports.size > 1) return ticked ? filledWith(String(ticked.value)) : EMPTY;
      return ticked ? { text: "☑", filled: true } : { text: "☐", filled: false };
    }
    case "radiobutton": {
      const selected = widgets.find((widget) => isOn(widget.value));
      return selected ? filledWith(String(selected.value)) : EMPTY;
    }
    case "combobox":
    case "listbox": {
      const values = widgets.flatMap((widget) => choices(widget, selections));
      const selected = [...new Set(values)].filter((value) => value.trim() !== "");
      return selected.length > 0 ? filledWith(selected.join(", ")) : EMPTY;
    }
    default: {
      const value = widgets.map((widget) => widget.value).find((value) => typeof value === "string" && value.trim());
      return typeof value === "string" ? filledWith(value.trim()) : EMPTY;
    }
  }
}

const EMPTY: FieldValue = { text: "", filled: false };

function filledWith(text: string): FieldValue {
  return { text: escapeInline(text), filled: true };
}

/** A button's value is its export name when it's on, and `Off` when it isn't. */
function isOn(value: unknown): boolean {
  return typeof value === "string" && value !== "" && value !== "Off";
}

/**
 * A choice field's selections, as the text the form shows rather than the
 * export value it stores, where the two differ.
 */
function choices(widget: FieldObject, selections: Map<string, unknown[]>): string[] {
  return (selections.get(widget.id) ?? [widget.value])
    .filter((value): value is string => typeof value === "string")
    .map((value) => widget.items?.find((item) => item.exportValue === value)?.displayValue ?? value);
}

/**
 * Fields in the order they sit on the page — down, then across — so the table
 * reads like the form. `getFieldObjects()` gives no order to rely on.
 *
 * Fields on one line rarely share an exact baseline, so they're gathered into
 * lines first and each line read left to right. Comparing pairs with a
 * tolerance instead would make the order depend on which fields happened to
 * be compared: two fields can each be "level" with a third without being
 * level with each other.
 */
function inReadingOrder(fields: Field[]): Field[] {
  const placed = fields
    .map((field) => ({ field, position: positionOf(field) }))
    .sort((a, b) => a.position[0] - b.position[0] || b.position[1] - a.position[1]);

  const lines: (typeof placed)[] = [];
  for (const entry of placed) {
    const line = lines[lines.length - 1];
    const level = line && line[0].position[0] === entry.position[0] && line[0].position[1] - entry.position[1] <= 4;
    if (level) line.push(entry);
    else lines.push([entry]);
  }
  return lines.flatMap((line) => line.sort((a, b) => a.position[2] - b.position[2]).map((entry) => entry.field));
}

function positionOf(field: Field): [number, number, number] {
  const placed: [number, number, number][] = [];
  for (const { page, rect } of field.widgets) {
    if (page !== undefined && rect !== undefined) placed.push([page, rect[3], rect[0]]);
  }
  placed.sort((a, b) => a[0] - b[0] || b[1] - a[1] || a[2] - b[2]);
  // A field with no widget on any page goes after everything that has one.
  return placed[0] ?? [Number.MAX_SAFE_INTEGER, 0, 0];
}

function nameList(names: string[]): string {
  return names.map(escapeInline).join(", ");
}
