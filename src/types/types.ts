import { LayoutPage } from "../layout/page";
import { FieldSpec } from "./fields";
import { DateOrder } from "./values";

/**
 * A kind of document the user can say a file is, so that its note is
 * shaped for that kind: the facts that matter as properties, and a layout
 * from a template.
 */
export interface DocumentType {
  id: string;
  /** As shown in menus: "Convert to Markdown as {name}". */
  name: string;
  /** The template used when the user hasn't chosen a template note. */
  defaultTemplate: string;
  /** The fields it reads, for settings to list. */
  fields: FieldSpec[];
  /**
   * Reads the type's fields from the document's pages. `extraLabels` are
   * the user's own, by field key, counted like the built-in ones.
   */
  read(pages: LayoutPage[], order: DateOrder, extraLabels?: Record<string, string[]>): TypedResult;
}

export interface TypedResult {
  /** By key, for the template's `{{placeholders}}`. `null` is not found; money is a number, a date ISO. */
  fields: Record<string, string | number | null>;
  /** Multi-line Markdown the type provides, like `line_items`. */
  blocks: Record<string, string>;
  /** Fields the type expects on every document that weren't found. */
  missing: string[];
  /** Fields read by OCR, and so possibly misread. */
  ocr: string[];
  /** Fields that came from a fallback rather than a label. */
  guessed: string[];
  /** Dates that read either way round, decided by the date order setting. */
  ambiguous: string[];
  /** What didn't add up, for the conversion notes. */
  warnings: string[];
}
