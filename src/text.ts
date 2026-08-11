/**
 * Turning bytes into text, for the formats that are text to begin with.
 *
 * The OOXML extractors never need this — a zip entry's encoding is fixed by
 * the spec at UTF-8 — but a `.srt` off the internet, a `.csv` out of Excel and
 * an email body all arrive as bytes whose encoding has to be worked out before
 * a single character can be read.
 */

/** Byte-order marks, longest first so UTF-8's three bytes win over any prefix. */
const BOMS: { bytes: number[]; encoding: string }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
];

/**
 * Decodes a text file, in the order the evidence is trustworthy: a byte-order
 * mark is the file stating its own encoding and always wins, then whatever the
 * container declared (a MIME `charset`, an XML declaration), then UTF-8.
 *
 * The last resort is windows-1252 rather than an error. Every byte sequence is
 * valid windows-1252, so decoding always succeeds — and a legacy subtitle or a
 * CSV exported by an older Excel is far more often windows-1252 than anything
 * else. Guessing wrong there costs a few mangled accents; refusing the file
 * costs the whole conversion.
 */
export function decodeText(data: Buffer, declaredCharset?: string | null): string {
  for (const { bytes, encoding } of BOMS) {
    if (startsWith(data, bytes)) return decodeWith(data.subarray(bytes.length), encoding) ?? "";
  }

  if (declaredCharset) {
    const decoded = decodeWith(data, declaredCharset);
    if (decoded !== null) return isWindows1252(declaredCharset) ? repairC1(decoded) : decoded;
  }

  // `fatal` is what makes this a test rather than a decode: UTF-8 is
  // self-validating, so a file that decodes cleanly as UTF-8 essentially is
  // UTF-8, and one that throws is definitely something else.
  const utf8 = decodeWith(data, "utf-8", true);
  if (utf8 !== null) return utf8;

  return repairC1(decodeWith(data, "windows-1252") ?? data.toString("latin1"));
}

/**
 * Only the encodings whose C1 range really is the windows-1252 table.
 *
 * Deliberately not the other windows code pages: 1250 and 1251 fill the same
 * byte range with different characters, so applying this table to them would
 * turn a decoder bug into a wrong answer instead of a right one. `iso-8859-1`
 * and `us-ascii` are here because every browser treats them as windows-1252,
 * and mail that declares either while using curly quotes is routine.
 */
function isWindows1252(charset: string): boolean {
  return /^(x-)?(windows|cp|ansi)[-_]?1252$|^iso[-_]?8859[-_]?1$|^latin1$|^us[-_]?ascii$|^ascii$/i.test(
    charset.trim()
  );
}

/**
 * The 32 characters windows-1252 puts where ISO-8859-1 has unused control
 * codes: curly quotes, the en and em dash, the ellipsis, the bullet, the euro.
 *
 * They have to be spelled out because `TextDecoder` cannot be relied on for
 * them. Node's `windows-1252` decoder returns the C1 control character for
 * every one of these rather than the character the encoding actually defines
 * — `0x92` comes back as U+0092 instead of `’` — and a platform whose
 * decoder is correct simply never produces a C1 character for this repair to
 * find. So the pass is a no-op where the decoder is right and a fix where it
 * isn't, rather than a guess about which platform is underneath.
 *
 * This matters more than its size suggests: an apostrophe, a dash and an
 * ellipsis are the most common non-ASCII characters in anything written in
 * Word or Outlook, so getting them wrong disfigures ordinary business prose
 * on nearly every line.
 */
const WINDOWS_1252_C1 =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021" + // 0x80-0x87
  "\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" + // 0x88-0x8f
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014" + // 0x90-0x97
  "\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178"; // 0x98-0x9f

// The five bytes windows-1252 leaves undefined (0x81, 0x8d, 0x8f, 0x90, 0x9d)
// map back to themselves, so nothing is invented for a byte that means nothing.
// eslint-disable-next-line no-control-regex
const C1_RANGE = /[\u0080-\u009f]/g;

function repairC1(text: string): string {
  return text.replace(C1_RANGE, (char) => WINDOWS_1252_C1[char.charCodeAt(0) - 0x80]);
}

function decodeWith(data: Buffer, encoding: string, fatal = false): string | null {
  try {
    return new TextDecoder(encoding, { fatal }).decode(data);
  } catch {
    // Either an encoding label this platform doesn't know, or (with `fatal`)
    // bytes that aren't valid in it. Both mean "not this one".
    return null;
  }
}

function startsWith(data: Buffer, bytes: number[]): boolean {
  if (data.length < bytes.length) return false;
  return bytes.every((byte, index) => data[index] === byte);
}

/** Splits on any of the three line endings, so CRLF files don't keep the CR. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  szlig: "ß",
  pound: "£",
  euro: "€",
  laquo: "«",
  raquo: "»",
};

/**
 * Resolves the character references that appear in subtitle cues, HTML bodies
 * and email text alike.
 *
 * Numeric references cover most of what turns up in practice; the named list
 * is the handful HTML authors actually type, not all 2231 of them — an
 * unrecognised name is left exactly as written rather than swallowed, so
 * nothing is silently lost to a gap in the table.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;

  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, reference: string) => {
    if (reference.startsWith("#")) {
      const hex = reference[1] === "x" || reference[1] === "X";
      const code = parseInt(hex ? reference.slice(2) : reference.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[reference] ?? NAMED_ENTITIES[reference.toLowerCase()] ?? whole;
  });
}
