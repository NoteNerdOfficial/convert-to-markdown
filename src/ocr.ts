/**
 * Where the OCR engine comes from.
 *
 * Tesseract's recogniser and language model aren't shipped in the plugin —
 * an Obsidian release can only contain main.js, manifest.json and styles.css
 * — so by default they're fetched from a CDN on first use. On a machine where
 * that CDN is blocked, the files can be supplied from a folder in the vault
 * instead; this is how the extractor is told which of the two is happening,
 * without it needing to know anything about vaults.
 */
export interface OcrEngineFiles {
  /** Contents of a `tesseract-core-*.wasm.js` build. */
  core: ArrayBuffer;
  /** Contents of `eng.traineddata`, gzipped or not — Tesseract detects it. */
  language: ArrayBuffer;
}

export interface OcrProvider {
  /** Locally supplied engine files, or null to let Tesseract use its CDN. */
  resolve(): Promise<OcrEngineFiles | null>;
}

/** The default: Tesseract downloads its own engine and caches it. */
export const CDN_OCR: OcrProvider = {
  async resolve() {
    return null;
  },
};

/** Core builds in the order they're preferred when a folder holds several. */
export const CORE_FILE_PREFERENCE = [
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
  "tesseract-core-simd.wasm.js",
  "tesseract-core.wasm.js",
];

export const LANGUAGE_FILE_NAMES = ["eng.traineddata", "eng.traineddata.gz"];
