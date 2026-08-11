import { AssetSink } from "../assets";
import { escapeInline, joinBlocks } from "../markdown";
import { CDN_OCR, OcrProvider } from "../ocr";
import { recognize } from "../recognize";
import { ExtractResult } from "./types";

/**
 * Image → Markdown by OCR.
 *
 * This is the one *file format* that can't be read structurally: a JPEG has no
 * text to extract, only pixels that look like text. Everything else here is
 * parsed; this is recognised, which is why it reports a confidence and nothing
 * else does. (The pages of a scanned PDF take the same route — see pdf.ts.)
 *
 * The engine is Tesseract, running locally in WASM. It is not an LLM, takes no
 * API key, and sends the image nowhere. What it can't do is understand: it
 * gives back the words on the page, not "this is an invoice and here's the
 * vendor field".
 *
 * The one caveat is first use. The recognition engine and the English training
 * data (~9 MB together) are downloaded on the first conversion and cached
 * afterwards, so an image conversion needs a network connection once — unless
 * the files are supplied from a vault folder instead. Nothing about the image
 * itself leaves the machine either way.
 */
export async function extractImage(
  data: Buffer,
  assets: AssetSink,
  ocr: OcrProvider = CDN_OCR
): Promise<ExtractResult> {
  const format = sniffImageFormat(data);
  if (!format) throw new Error("not a readable image (unrecognised file signature)");

  const embed = await assets.save(data, format);
  const { paragraphs, confidence, discarded } = await recognize(data, ocr);

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
