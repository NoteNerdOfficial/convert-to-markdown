import { yamlValue } from "../markdown";
import { renderPlainText } from "../plaintext";
import { decodeTextWithEncoding, splitLines } from "../text";
import { ExtractResult } from "./types";

/**
 * .txt → Markdown that reads exactly as the text file did.
 *
 * A text file has no structure to map beyond its lines, so the work is the
 * opposite of every other extractor's: not finding structure, but stopping
 * Markdown from finding structure that isn't there. See plaintext.ts.
 *
 * What a text file doesn't state is its encoding, so the one thing worth
 * reporting is how that was settled — and, when it had to be assumed, saying
 * so, since a wrong guess shows up as mangled accents rather than an error.
 */
export async function extractTxt(data: Buffer): Promise<ExtractResult> {
  const { text, encoding, guessed } = decodeTextWithEncoding(data);

  if (text.trim() === "") throw new Error("the file is empty");
  // A NUL never appears in text. Seeing one means the file is binary under a
  // .txt name, or UTF-16 without the byte-order mark that would have said so.
  if (text.includes("\u0000")) {
    throw new Error("the file contains NUL bytes, so it isn't plain text (or is UTF-16 without a byte-order mark)");
  }

  const warnings: string[] = [];
  if (guessed) {
    warnings.push(
      "The file isn't valid UTF-8 and doesn't declare an encoding, so it was read as windows-1252. " +
        "If accented letters look wrong, the file is in some other legacy encoding."
    );
  }

  // Every line is converted — nothing in a text file is skipped — but the count
  // is stated the way every other format states its coverage.
  const lineCount = splitLines(text.replace(/(\r\n|\r|\n)$/, "")).length;

  return {
    markdown: renderPlainText(text).join("\n"),
    warnings,
    frontmatter: {
      lines_converted: `${lineCount}/${lineCount}`,
      encoding: yamlValue(guessed ? `${encoding} (assumed)` : encoding),
    },
  };
}
