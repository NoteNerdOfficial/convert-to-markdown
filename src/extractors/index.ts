import { extractDocx } from "./docx";
import { extractImage } from "./image";
import { extractPdf } from "./pdf";
import { extractPptx } from "./pptx";
import { extractXlsx } from "./xlsx";
import { Extractor, ExtractResult } from "./types";

export type { ExtractResult };

/**
 * One extractor per format, rather than one abstraction over all of them.
 *
 * That's the whole design premise: a generalist converter has to make
 * one-size-fits-all decisions about what structure means, and those decisions
 * are what make its output messy. Here, each format's own structure —
 * Word's paragraph styles, PowerPoint's placeholders, Excel's number formats,
 * a PDF's glyph geometry — drives its own mapping to Markdown.
 *
 * Images are the exception, and the only one: pixels carry no structure, so
 * they go through OCR (see image.ts).
 */
const EXTRACTORS: Record<string, Extractor> = {
  pdf: extractPdf,
  docx: extractDocx,
  pptx: extractPptx,
  xlsx: extractXlsx,
  // Macro-enabled variants are the same OOXML parts plus a VBA blob, which
  // the extractors simply never look at.
  docm: extractDocx,
  pptm: extractPptx,
  xlsm: extractXlsx,
  png: extractImage,
  jpg: extractImage,
  jpeg: extractImage,
  webp: extractImage,
  gif: extractImage,
  bmp: extractImage,
  tif: extractImage,
  tiff: extractImage,
};

export const SUPPORTED_EXTENSIONS = Object.keys(EXTRACTORS);

export function extractorFor(extension: string): Extractor | null {
  return EXTRACTORS[extension.toLowerCase()] ?? null;
}

export function isSupported(extension: string): boolean {
  return extension.toLowerCase() in EXTRACTORS;
}
