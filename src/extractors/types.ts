import { AssetSink } from "../assets";
import { OcrProvider } from "../ocr";

export interface ExtractResult {
  markdown: string;
  /** Things the reader should know were dropped or guessed, surfaced in the note. */
  warnings: string[];
}

/**
 * `ocr` is only ever used by the image extractor — the document formats have
 * structure to read and never need a recogniser — so they simply declare the
 * two parameters they use and ignore the third.
 */
export type Extractor = (data: Buffer, assets: AssetSink, ocr: OcrProvider) => Promise<ExtractResult>;
