import { AssetSink } from "../assets";
import { OcrProvider } from "../ocr";

export interface ExtractResult {
  markdown: string;
  /** Things the reader should know were dropped or guessed, surfaced in the note. */
  warnings: string[];
  /**
   * Extra frontmatter keys describing the conversion itself — coverage counts
   * and the like. They belong at the top of the note rather than in the
   * warnings callout: how much of the source made it across is the first thing
   * a reader needs, not a footnote after two thousand lines.
   */
  frontmatter?: Record<string, string>;
}

/** Per-conversion choices that come from the plugin's settings. */
export interface ExtractOptions {
  /**
   * Convert sheets Excel has marked hidden. On by default: hiding a sheet is a
   * presentation choice, and hidden sheets are routinely the raw data a
   * visible pivot table summarises.
   */
  includeHiddenSheets: boolean;
}

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
  includeHiddenSheets: true,
};

/**
 * `ocr` is only ever used by the image extractor — the document formats have
 * structure to read and never need a recogniser — and `options` currently only
 * by the spreadsheet one, so extractors simply declare the parameters they use
 * and ignore the rest.
 */
export type Extractor = (
  data: Buffer,
  assets: AssetSink,
  ocr: OcrProvider,
  options: ExtractOptions
) => Promise<ExtractResult>;
