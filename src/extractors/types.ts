export interface ExtractResult {
  markdown: string;
  /** Things the reader should know were dropped or guessed, surfaced in the note. */
  warnings: string[];
}

export type Extractor = (data: Buffer) => Promise<ExtractResult>;
