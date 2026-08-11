import { AssetSink, imageExtensionForMime } from "../assets";
import {
  collectImageSources,
  documentRoot,
  findMainContent,
  ImageBytes,
  parseHtml,
  renderHtml,
  resolveImages,
} from "../html";
import { alreadyTitled, escapeInline, heading, joinBlocks, yamlValue } from "../markdown";
import { decodeHeaderText, firstHeader, flattenParts, MimePart, parseMime, partText } from "../mime";
import { ExtractResult } from "./types";

/**
 * .eml and .mhtml → Markdown.
 *
 * One extractor for both, because they are one format. An MHTML file is an
 * email: the same headers, the same multipart body, the same transport
 * encodings — with a web page in the first part and its images in the rest.
 * Chrome and Word save pages this way precisely because MIME already solved
 * bundling a document with its resources.
 *
 * What differs is only what the parts mean, and that is all these two entry
 * points decide: an email has correspondents and a subject and possibly
 * attachments; a saved page has a URL and page furniture to leave out.
 */
export async function extractEml(data: Buffer, assets: AssetSink): Promise<ExtractResult> {
  const message = parseMime(data);
  const warnings: string[] = [];
  const lines: string[] = [];

  lines.push(...(await renderMessage(message, assets, warnings, 0)));

  // The subject names the message, and an HTML body very often opens with the
  // same words as its own `<h1>` — adding it unconditionally would give half
  // of all mail the same heading twice.
  const subject = header(message, "subject");
  if (subject && !alreadyTitled(lines, subject)) lines.unshift(heading(1, escapeInline(subject)), "");

  const frontmatter: Record<string, string> = {};
  for (const [key, name] of [
    ["from", "from"],
    ["to", "to"],
    ["cc", "cc"],
    ["date", "date"],
  ] as const) {
    const value = header(message, name);
    if (value) frontmatter[key] = yamlValue(value);
  }
  if (subject) frontmatter.subject = yamlValue(subject);

  return { markdown: joinBlocks(lines), warnings, frontmatter };
}

export async function extractMhtml(data: Buffer, assets: AssetSink): Promise<ExtractResult> {
  const archive = parseMime(data);
  const parts = flattenParts(archive);
  const page = parts.find((part) => part.contentType === "text/html");
  if (!page) throw new Error("no HTML part in this archive — it may be a plain email rather than a saved page");

  const warnings: string[] = [];
  const { lines, dropped } = await renderPage(partText(page), parts, assets, { stripFurniture: true });
  if (dropped.length > 0) {
    warnings.push(`Page furniture left out: ${dropped.join(", ")}.`);
  }

  // Chrome writes the page's address on the archive itself, other savers only
  // on the part; either is the URL this note came from.
  const location =
    firstHeader(archive.headers, "snapshot-content-location") ?? archive.contentLocation ?? page.contentLocation;

  const frontmatter: Record<string, string> = {};
  if (location) frontmatter.url = yamlValue(location);
  const date = header(archive, "date");
  if (date) frontmatter.saved = yamlValue(date);

  const unusedParts = parts.filter(
    (part) => part !== page && !part.contentType.startsWith("image/") && part.contentType !== "text/html"
  );
  if (unusedParts.length > 0) {
    // Stylesheets and scripts are saved alongside the page and are not
    // content; saying so is the difference between a reader assuming the
    // archive held only what's here and knowing what was set aside.
    const types = [...new Set(unusedParts.map((part) => part.contentType))].sort();
    warnings.push(`Non-content parts of the archive left out: ${types.join(", ")}.`);
  }

  return { markdown: joinBlocks(lines), warnings, frontmatter };
}

function header(part: MimePart, name: string): string | null {
  const raw = firstHeader(part.headers, name);
  return raw ? decodeHeaderText(raw).trim() || null : null;
}

/** How deep a chain of forwarded messages is followed before it's just noise. */
const MAX_FORWARD_DEPTH = 4;

async function renderMessage(
  message: MimePart,
  assets: AssetSink,
  warnings: string[],
  depth: number
): Promise<string[]> {
  const parts = flattenParts(message);
  const body = chooseBody(message);
  const lines: string[] = [];

  if (depth > 0) {
    // A forwarded or bounced message arrives as a whole message inside a part.
    // Its own headers are what make it readable as a separate message rather
    // than as more of the covering note.
    const from = header(message, "from");
    const date = header(message, "date");
    const subject = header(message, "subject");
    lines.push(
      "",
      heading(Math.min(depth + 1, 6), `Forwarded message${subject ? `: ${escapeInline(subject)}` : ""}`),
      ""
    );
    if (from) lines.push(`**From:** ${escapeInline(from)}`);
    const to = header(message, "to");
    if (to) lines.push(`**To:** ${escapeInline(to)}`);
    if (date) lines.push(`**Date:** ${escapeInline(date)}`);
    lines.push("");
  }

  // Inline images belong to the HTML body and are addressed by `cid:`. When
  // the plain-text alternative is the one converted, none of them are placed —
  // so they have to be treated as attachments instead, or a message that says
  // "see the chart below" comes out with no chart anywhere.
  const placed = new Set<string>();

  if (!body) {
    warnings.push("This message has no text body — it may be attachments only.");
  } else if (body.chosen.contentType === "text/html") {
    const page = await renderPage(partText(body.chosen), parts, assets, { stripFurniture: false });
    lines.push(...page.lines);
    for (const cid of page.placedCids) placed.add(cid);
    if (body.alternative) {
      warnings.push(
        "Converted the HTML version of this message; the plain-text alternative it also carried was a stub."
      );
    }
  } else {
    lines.push(...renderPlainText(partText(body.chosen)));
    if (body.alternative) {
      warnings.push(
        "Converted the plain-text version of this message. It also carried an HTML version, which says the " +
          "same thing with styling this note doesn't need."
      );
    }
  }

  const bodyParts = new Set(body ? [body.chosen, ...(body.alternative ? [body.alternative] : [])] : []);
  lines.push(...(await renderAttachments(parts, bodyParts, placed, assets, warnings, depth)));

  return lines;
}

/**
 * Picks the body out of a message, and says whether it had an alternative.
 *
 * `multipart/alternative` carries the same message twice — the sender's text
 * and an HTML rendering of it — so exactly one has to be chosen or the note
 * says everything twice. Plain text wins by default: it is what the sender
 * actually typed, and the HTML alternative of an ordinary email is that same
 * text wrapped in styling that means nothing once it's a note.
 *
 * The exception is the stub. Bulk senders put "This email requires an HTML
 * viewer" in the plain part and the entire message in the HTML one, so a plain
 * part far shorter than its alternative is a placeholder, not the message.
 */
function chooseBody(message: MimePart): { chosen: MimePart; alternative: MimePart | null } | null {
  const parts = flattenParts(message).filter((part) => part.disposition !== "attachment");
  const plain = parts.find((part) => part.contentType === "text/plain");
  const html = parts.find((part) => part.contentType === "text/html");

  if (plain && html) {
    const plainLength = partText(plain).trim().length;
    const htmlLength = textLengthOf(partText(html));
    const isStub = plainLength < 200 && plainLength < htmlLength * 0.6;
    return isStub ? { chosen: html, alternative: plain } : { chosen: plain, alternative: html };
  }

  const only = plain ?? html;
  return only ? { chosen: only, alternative: null } : null;
}

function textLengthOf(html: string): number {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

/**
 * Renders an HTML body, resolving its images against the sibling MIME parts.
 *
 * An HTML message or saved page addresses its images by `cid:` (an email's
 * inline attachment) or by the URL they were fetched from (a saved page's
 * `Content-Location`). Both point at another part of the same file, so the
 * bytes are always there — they just aren't where the `src` says they are.
 */
async function renderPage(
  html: string,
  parts: MimePart[],
  assets: AssetSink,
  options: { stripFurniture: boolean }
): Promise<{ lines: string[]; dropped: string[]; placedCids: string[] }> {
  const document = parseHtml(html);
  const dropped: string[] = [];

  let root: Element | null;
  if (options.stripFurniture) {
    const main = findMainContent(document);
    root = main.root;
    dropped.push(...main.dropped);
  } else {
    root = documentRoot(document);
  }
  if (!root) return { lines: [], dropped, placedCids: [] };

  const byCid = new Map<string, MimePart>();
  const byLocation = new Map<string, MimePart>();
  for (const part of parts) {
    if (part.contentId) byCid.set(part.contentId, part);
    if (part.contentLocation) byLocation.set(part.contentLocation, part);
  }

  const { images } = await resolveImages(collectImageSources(root), assets, (src) => {
    const part = src.toLowerCase().startsWith("cid:") ? byCid.get(src.slice(4)) : byLocation.get(src);
    if (!part) return null;
    const extension = imageExtensionForMime(part.contentType);
    return extension ? ({ data: part.body, extension } as ImageBytes) : null;
  });

  const placedCids = [...images.keys()]
    .filter((src) => src.toLowerCase().startsWith("cid:"))
    .map((src) => src.slice(4));

  return { lines: renderHtml(root, { images }), dropped, placedCids };
}

/**
 * A plain-text body, kept as text.
 *
 * The only structure a text email has is its quoting — `>` at the start of a
 * line, which is already Markdown's blockquote and so needs nothing done to
 * it. Everything else stays exactly as typed, since guessing that a line of
 * dashes was meant as a rule, or that an indented block was meant as code, is
 * how a converter invents structure the sender didn't write.
 */
function renderPlainText(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    // A quoted line is a blockquote already; everything else is escaped so
    // that a stray asterisk or underscore in prose stays visible.
    lines.push(/^\s*>/.test(line) ? line : escapeInline(line));
  }
  // Text mail is hard-wrapped, so a single newline is a real line break here
  // rather than a paragraph continuation — the lines are kept as lines.
  return [lines.join("\n").trim()];
}

async function renderAttachments(
  parts: MimePart[],
  bodyParts: Set<MimePart>,
  placedCids: Set<string>,
  assets: AssetSink,
  warnings: string[],
  depth: number
): Promise<string[]> {
  const lines: string[] = [];
  const named: string[] = [];

  for (const part of parts) {
    if (bodyParts.has(part)) continue;
    if (part.contentType.startsWith("multipart/")) continue;

    // A forwarded message is content, not an attachment, and reads as one.
    if (part.contentType === "message/rfc822") {
      if (depth + 1 > MAX_FORWARD_DEPTH) {
        warnings.push("A chain of forwarded messages was deeper than four levels; the rest was not followed.");
        continue;
      }
      lines.push(...(await renderMessage(parseMime(part.body), assets, warnings, depth + 1)));
      continue;
    }

    // Skip only the inline images the body actually placed. One whose `cid:`
    // never got resolved — because the HTML that referenced it wasn't the
    // version converted — is content that would otherwise vanish.
    if (part.contentId !== null && placedCids.has(part.contentId)) continue;

    const extension = imageExtensionForMime(part.contentType);
    if (extension) {
      const embed = await assets.save(part.body, extension);
      if (embed) {
        lines.push("", embed, "");
        continue;
      }
    }

    // Everything else — a PDF, a spreadsheet, a zip — is named rather than
    // written out. It is a whole document of its own, and the useful thing to
    // say about it is that it exists and what it's called.
    if (part.body.length > 0) {
      named.push(`${part.filename ?? `unnamed ${part.contentType}`} (${describeSize(part.body.length)})`);
    }
  }

  if (named.length > 0) {
    warnings.push(
      `${named.length} attachment${named.length === 1 ? "" : "s"} not converted — open the original message ` +
        `for ${named.length === 1 ? "it" : "them"}: ${named.join(", ")}.`
    );
  }

  return lines;
}

function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
