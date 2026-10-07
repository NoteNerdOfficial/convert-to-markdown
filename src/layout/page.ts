import { DetectedTable, LayoutRow } from "./tables";

/**
 * A page as positioned text: what document types read their fields from.
 *
 * The Markdown a conversion produces has already decided what's a heading
 * and what's a paragraph; finding "the value beside *Invoice date*" needs
 * the page as it was laid out instead — which text sat on which line, and
 * where along it.
 */
export interface LayoutPage {
  /** 1-based, in the source document. */
  page: number;
  /** Lines across the page, top first, `y` growing down. */
  rows: LayoutRow[];
  /** Tables found among those rows. */
  tables: DetectedTable[];
  /** Whether the text was extracted exactly, or recognised by OCR and so may be wrong. */
  source: "text" | "ocr";
}
