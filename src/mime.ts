import { decodeText } from "./text";

/**
 * MIME, shared by `.eml` and `.mhtml`.
 *
 * These two look like different formats and are the same one: a saved web page
 * in MHTML is an email whose parts happen to be a page and its images. Both
 * are a header block, a body, and — when the body is `multipart/*` — the same
 * structure again inside it, recursively.
 *
 * Almost all of the work here is undoing transport encodings. MIME's job was
 * to move arbitrary bytes over a channel that only carried 7-bit ASCII, so
 * everything interesting is encoded twice over: the body in base64 or
 * quoted-printable, and any non-ASCII header text in RFC 2047 words that have
 * their own charset each. None of the content is readable until all of that is
 * reversed.
 */

export interface MimePart {
  /** Raw header values, keyed by lowercased name; a name can repeat. */
  headers: Map<string, string[]>;
  /** Lowercased `type/subtype`, defaulting to what the spec says to assume. */
  contentType: string;
  /** Content-Type parameters, lowercased keys — `charset`, `boundary`, `name`. */
  parameters: Record<string, string>;
  /** `attachment`, `inline`, or "" when the part didn't say. */
  disposition: string;
  filename: string | null;
  /** Content-ID with its angle brackets removed, for resolving `cid:` links. */
  contentId: string | null;
  /** Where this part came from, used by MHTML to resolve a page's `src`. */
  contentLocation: string | null;
  /** Decoded bytes. Empty for a multipart, whose content is in `parts`. */
  body: Buffer;
  parts: MimePart[];
}

export function parseMime(data: Buffer): MimePart {
  // latin1 maps every byte to exactly one character and back, so string
  // offsets are byte offsets. That is what makes it safe to find boundaries
  // and header breaks by string search in a part that may hold a JPEG.
  return parsePart(data.toString("latin1"));
}

function parsePart(raw: string): MimePart {
  const split = findHeaderBreak(raw);
  const headerText = raw.slice(0, split.end);
  const bodyText = raw.slice(split.bodyStart);

  const headers = parseHeaders(headerText);
  const contentTypeHeader = firstHeader(headers, "content-type") ?? "";
  const { value: contentType, parameters } = parseParameterised(contentTypeHeader);
  const dispositionHeader = firstHeader(headers, "content-disposition") ?? "";
  const disposition = parseParameterised(dispositionHeader);

  const part: MimePart = {
    headers,
    contentType: (contentType || "text/plain").toLowerCase(),
    parameters,
    disposition: disposition.value.toLowerCase(),
    filename: disposition.parameters.filename ?? parameters.name ?? null,
    contentId: (firstHeader(headers, "content-id") ?? "").trim().replace(/^<|>$/g, "") || null,
    contentLocation: (firstHeader(headers, "content-location") ?? "").trim() || null,
    body: Buffer.alloc(0),
    parts: [],
  };

  if (part.contentType.startsWith("multipart/") && parameters.boundary) {
    part.parts = splitMultipart(bodyText, parameters.boundary).map(parsePart);
    return part;
  }

  const encoding = (firstHeader(headers, "content-transfer-encoding") ?? "").trim().toLowerCase();
  part.body = decodeBody(bodyText, encoding);
  return part;
}

/**
 * A blank line ends the headers. Both line endings have to be accepted: the
 * standard says CRLF, and files written by anything other than a mail server
 * routinely use LF.
 */
function findHeaderBreak(raw: string): { end: number; bodyStart: number } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");

  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { end: crlf, bodyStart: crlf + 4 };
  if (lf !== -1) return { end: lf, bodyStart: lf + 2 };
  // No blank line at all: headers only, no body.
  return { end: raw.length, bodyStart: raw.length };
}

function parseHeaders(text: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  // A header value continues onto the next line when that line starts with
  // whitespace; unfolding first means the rest of the parsing sees one line.
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");

  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(name);
    if (existing) existing.push(value);
    else headers.set(name, [value]);
  }
  return headers;
}

export function firstHeader(headers: Map<string, string[]>, name: string): string | null {
  return headers.get(name.toLowerCase())?.[0] ?? null;
}

/** A header's value with its parameters — `text/html; charset="utf-8"`. */
function parseParameterised(header: string): { value: string; parameters: Record<string, string> } {
  const segments = splitOutsideQuotes(header, ";");
  const value = (segments.shift() ?? "").trim();

  const raw: Record<string, string> = {};
  for (const segment of segments) {
    const equals = segment.indexOf("=");
    if (equals === -1) continue;
    const key = segment.slice(0, equals).trim().toLowerCase();
    let text = segment.slice(equals + 1).trim();
    if (text.startsWith('"')) text = text.slice(1, text.endsWith('"') ? -1 : undefined).replace(/\\(.)/g, "$1");
    raw[key] = text;
  }

  return { value, parameters: resolveExtendedParameters(raw) };
}

/**
 * Reassembles RFC 2231 parameters.
 *
 * A long or non-ASCII filename is split across numbered parameters and
 * percent-encoded with its own charset — `filename*0*=utf-8''%E2%82%AC` — so
 * an attachment called `Rapport financier — 2024.pdf` arrives as three
 * separate header parameters. Read naively, its name comes out as `utf-8''%E2`.
 */
function resolveExtendedParameters(raw: Record<string, string>): Record<string, string> {
  const continuations = new Map<string, { index: number; text: string; encoded: boolean }[]>();
  const parameters: Record<string, string> = {};

  for (const [key, text] of Object.entries(raw)) {
    const match = /^([^*]+)\*(\d+)(\*?)$/.exec(key);
    if (match) {
      const [, name, index, star] = match;
      const list = continuations.get(name) ?? [];
      list.push({ index: Number(index), text, encoded: star === "*" });
      continuations.set(name, list);
      continue;
    }
    if (key.endsWith("*")) {
      parameters[key.slice(0, -1)] = decodeExtendedValue(text);
      continue;
    }
    if (parameters[key] === undefined) parameters[key] = text;
  }

  for (const [name, pieces] of continuations) {
    pieces.sort((a, b) => a.index - b.index);
    const joined = pieces.map((piece) => piece.text).join("");
    parameters[name] = pieces.some((piece) => piece.encoded) ? decodeExtendedValue(joined) : joined;
  }

  return parameters;
}

/** `charset'language'percent-encoded-bytes`. */
function decodeExtendedValue(text: string): string {
  const match = /^([^']*)'([^']*)'([\s\S]*)$/.exec(text);
  const charset = match ? match[1] : null;
  const encoded = match ? match[3] : text;

  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index++) {
    if (encoded[index] === "%" && /^[0-9a-fA-F]{2}$/.test(encoded.slice(index + 1, index + 3))) {
      bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encoded.charCodeAt(index) & 0xff);
    }
  }
  return decodeText(Buffer.from(bytes), charset);
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && quoted) {
      current += char + (text[++index] ?? "");
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === separator && !quoted) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments;
}

/**
 * Splits a multipart body at its boundary lines.
 *
 * The delimiter is `--boundary` at the start of a line, and `--boundary--`
 * ends the sequence. The check that nothing but whitespace follows on that
 * line matters: boundaries are commonly chosen as one string plus a suffix,
 * and a prefix match would cut a part in half.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const segments: string[] = [];
  let openedAt: number | null = null;

  for (let cursor = body.indexOf(marker); cursor !== -1; cursor = body.indexOf(marker, cursor + 1)) {
    if (cursor !== 0 && body[cursor - 1] !== "\n") continue;

    let lineEnd = body.indexOf("\n", cursor);
    if (lineEnd === -1) lineEnd = body.length;
    const trailing = body.slice(cursor + marker.length, lineEnd).trim();
    if (trailing !== "" && trailing !== "--") continue;

    if (openedAt !== null) {
      // The CRLF before the delimiter belongs to the delimiter, not the part.
      segments.push(body.slice(openedAt, trimLineEnding(body, cursor)));
    }
    if (trailing === "--") return segments;
    openedAt = lineEnd + 1;
  }

  // No closing delimiter — truncated file. Keep what's there rather than
  // discarding the last part.
  if (openedAt !== null && openedAt < body.length) segments.push(body.slice(openedAt));
  return segments;
}

function trimLineEnding(text: string, index: number): number {
  let end = index;
  if (end > 0 && text[end - 1] === "\n") end--;
  if (end > 0 && text[end - 1] === "\r") end--;
  return end;
}

function decodeBody(body: string, encoding: string): Buffer {
  if (encoding === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return Buffer.from(body, "latin1");
}

/**
 * Quoted-printable: `=XX` is a byte in hex, and `=` at end of line is a soft
 * break inserted to keep lines under 76 characters — it isn't in the content.
 */
function decodeQuotedPrintable(body: string): Buffer {
  const bytes: number[] = [];

  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char !== "=") {
      bytes.push(char.charCodeAt(0) & 0xff);
      continue;
    }

    const hex = body.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (body[index + 1] === "\r" && body[index + 2] === "\n") index += 2;
    else if (body[index + 1] === "\n") index += 1;
    // A stray `=` that is neither: keep it, since dropping it would silently
    // edit the text.
    else bytes.push(0x3d);
  }

  return Buffer.from(bytes);
}

/**
 * Decodes RFC 2047 encoded words in a header — `=?UTF-8?B?4oKsIDEwMA==?=`.
 *
 * Each word carries its own charset, so a header can legitimately mix them,
 * and they are decoded independently. Whitespace between two adjacent encoded
 * words is folding, not a space, and has to go before decoding: a subject line
 * split across three words would otherwise gain two spaces that were never in
 * the text.
 */
export function decodeHeaderText(text: string): string {
  if (!text.includes("=?")) return text;

  return text
    .replace(/\?=[ \t]+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, payload: string) => {
      const bytes =
        encoding.toLowerCase() === "b"
          ? Buffer.from(payload.replace(/[^A-Za-z0-9+/=]/g, ""), "base64")
          : // The Q encoding is quoted-printable with one extra rule: an
            // underscore stands for a space.
            decodeQuotedPrintable(payload.replace(/_/g, " "));
      const decoded = decodeText(bytes, charset);
      return decoded === "" && payload !== "" ? whole : decoded;
    });
}

/** Every leaf part in the tree, in document order. */
export function flattenParts(part: MimePart): MimePart[] {
  if (part.parts.length === 0) return [part];
  return part.parts.flatMap(flattenParts);
}

/** The text of a part, decoded with whatever charset it declared. */
export function partText(part: MimePart): string {
  return decodeText(part.body, part.parameters.charset ?? null);
}
