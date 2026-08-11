import { extractCsv, extractTsv } from "./delimited";
import { extractDocx } from "./docx";
import { extractEml, extractMhtml } from "./email";
import { extractEpub } from "./epub";
import { extractHtml } from "./html";
import { extractImage } from "./image";
import { extractIpynb } from "./ipynb";
import { extractOpenDocument } from "./opendocument";
import { extractPdf } from "./pdf";
import { extractPptx } from "./pptx";
import { extractSubtitles } from "./subtitles";
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
 * a PDF's glyph geometry, a caption file's timings — drives its own mapping to
 * Markdown.
 *
 * Two groups of formats share a reader, and both share it because they are
 * genuinely the same format underneath rather than merely similar: an epub
 * chapter, a saved web page and an email's HTML body are all HTML in different
 * envelopes, and an `.mhtml` archive is an email whose attachments happen to be
 * a web page's images.
 *
 * Images are the one format that can't be read structurally: pixels carry no
 * structure, so they go through OCR (see image.ts), as do the pages of a
 * scanned PDF.
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
  // OpenDocument. One reader for all three: `office:body` says which kind of
  // document it is, so the extension is only a hint.
  odt: extractOpenDocument,
  ods: extractOpenDocument,
  odp: extractOpenDocument,
  epub: extractEpub,
  html: extractHtml,
  htm: extractHtml,
  mhtml: extractMhtml,
  mht: extractMhtml,
  eml: extractEml,
  // Caption tracks: the same cue model, differing only in punctuation and a
  // signature line.
  vtt: extractSubtitles,
  srt: extractSubtitles,
  ipynb: extractIpynb,
  csv: extractCsv,
  tsv: extractTsv,
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
