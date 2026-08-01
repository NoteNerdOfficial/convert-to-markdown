import { createWorker, PSM } from "tesseract.js";
import { AssetSink } from "../assets";
import { escapeInline, joinBlocks, squashSpaces } from "../markdown";
import { ExtractResult } from "./types";

// tesseract.js's worker script, inlined at build time (see
// esbuild.config.mjs). Its default is to pull the worker off a CDN; a plugin
// release can't ship a second JS file, and fetching executable code at
// runtime is worth avoiding, so it gets the same Blob-URL treatment as the
// pdf.js worker.
declare const __TESSERACT_WORKER_SOURCE__: string;

let workerUrl: string | null = null;

/**
 * Image → Markdown by OCR.
 *
 * This is the one format that can't be read structurally: a JPEG has no text
 * to extract, only pixels that look like text. Tesseract is still not an LLM
 * — it's a classical OCR engine (line segmentation plus an LSTM character
 * recogniser) that runs locally in WASM, takes no API key and sends the image
 * nowhere. What it can't do is understand: it gives back the words on the
 * page, not "this is an invoice and here's the vendor field".
 *
 * The one caveat is first use. The recognition engine (~4 MB) and the English
 * training data (~15 MB) are downloaded on the first conversion and cached by
 * the browser afterwards, so an image conversion needs a network connection
 * once. Nothing about the image itself leaves the machine.
 */
export async function extractImage(data: Buffer, assets: AssetSink): Promise<ExtractResult> {
  const format = sniffImageFormat(data);
  if (!format) throw new Error("not a readable image (unrecognised file signature)");

  const embed = await assets.save(data, format);
  const { paragraphs, confidence, discarded } = await recognize(data);

  const warnings: string[] = [];
  if (paragraphs.length === 0) {
    warnings.push("OCR found no text in this image.");
  } else if (confidence < 70) {
    warnings.push(
      `OCR confidence was low (${Math.round(confidence)}%) — check the text against the image before relying on it.`
    );
  }
  if (discarded > 0) {
    warnings.push(
      `${discarded} unreadable region${discarded === 1 ? "" : "s"} dropped — usually text over a photo, or something that isn't text at all.`
    );
  }
  if (!embed) warnings.push("The image itself was not copied into the vault (image extraction is off).");

  return {
    markdown: joinBlocks([
      ...(embed ? [embed, ""] : []),
      ...paragraphs.flatMap((paragraph) => [escapeInline(paragraph), ""]),
    ]),
    warnings,
  };
}

/**
 * Anything Tesseract is this unsure of is noise, not text — lettering picked
 * out of a photograph, a logo, JPEG artefacts along an edge. Keeping it turns
 * the note into gibberish that reads as if it were content.
 */
const MIN_PARAGRAPH_CONFIDENCE = 60;

async function recognize(
  data: Buffer
): Promise<{ paragraphs: string[]; confidence: number; discarded: number }> {
  const worker = await createWorker("eng", undefined, workerOptions());
  try {
    // Tesseract's own default is to treat the image as one uniform block of
    // text, which flattens a page's headings, columns and captions into a
    // single run. AUTO runs its layout analysis first, which is what makes
    // paragraph structure available at all.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });

    // `blocks` is not part of the default output; without asking for it, the
    // only thing available is a flat string.
    const { data: result } = await worker.recognize(data, {}, { blocks: true, text: true });

    const paragraphs: string[] = [];
    let discarded = 0;

    for (const block of result.blocks ?? []) {
      for (const paragraph of block.paragraphs ?? []) {
        // Tesseract emits one line per line of pixels; rejoining them stops
        // the note being hard-wrapped at the image's column width.
        const text = squashSpaces(
          (paragraph.lines ?? [])
            .map((line) => line.text.trim())
            .filter((line) => line !== "")
            .join(" ")
        );
        if (text === "") continue;
        if (paragraph.confidence < MIN_PARAGRAPH_CONFIDENCE) discarded++;
        else paragraphs.push(text);
      }
    }

    return { paragraphs, confidence: result.confidence ?? 0, discarded };
  } finally {
    await worker.terminate();
  }
}

function workerOptions(): { workerPath?: string; workerBlobURL?: boolean } {
  // The Node harness (tools/convert.mjs) builds with an empty worker source
  // and can't run a Blob URL as a worker; tesseract.js's own node default
  // resolves to a real file there.
  if (__TESSERACT_WORKER_SOURCE__ === "") return {};

  if (!workerUrl) {
    const blob = new Blob([__TESSERACT_WORKER_SOURCE__], { type: "text/javascript" });
    workerUrl = URL.createObjectURL(blob);
  }
  return { workerPath: workerUrl, workerBlobURL: false };
}

/**
 * The image's real format, from its own magic bytes rather than its file
 * extension — a `.jpg` that is actually a PNG is common enough, and the
 * extension would otherwise decide the name it's saved under.
 */
function sniffImageFormat(data: Buffer): string | null {
  if (data.length < 12) return null;

  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpg";
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (data.subarray(0, 3).toString("ascii") === "GIF") return "gif";
  if (data[0] === 0x42 && data[1] === 0x4d) return "bmp";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  // TIFF, little- and big-endian.
  if (data.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00]))) return "tiff";
  if (data.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))) return "tiff";

  return null;
}
