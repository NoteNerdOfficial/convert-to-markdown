import { INVOICE } from "./invoice";
import { STATEMENT } from "./statement";
import { DocumentType } from "./types";

export type { DocumentType, TypedResult } from "./types";
export { composeTypedNote, conversionNotes } from "./compose";

/** Every document type, in menu order. */
export const DOCUMENT_TYPES: DocumentType[] = [INVOICE, STATEMENT];

/**
 * Formats a type can be read from: the ones that keep where their text sits.
 * Word and HTML files have tables of their own and are planned for later.
 */
const LAYOUT_FORMATS = new Set(["pdf", "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"]);

export function typesFor(extension: string): DocumentType[] {
  return LAYOUT_FORMATS.has(extension.toLowerCase()) ? DOCUMENT_TYPES : [];
}

export function typeById(id: string): DocumentType | undefined {
  return DOCUMENT_TYPES.find((type) => type.id === id);
}
