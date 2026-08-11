import { AssetSink, imageExtensionOf } from "../assets";
import { collectImageSources, documentRoot, ImageBytes, parseHtml, renderHtml, resolveImages } from "../html";
import { escapeInline, heading, joinBlocks, openingHeading, yamlValue } from "../markdown";
import { descendants, parseXml, resolvePartPath } from "../ooxml";
import { ZipArchive } from "../zip";
import { ExtractResult } from "./types";

const CONTAINER = "META-INF/container.xml";

/**
 * .epub → Markdown.
 *
 * An epub is a zip of XHTML files plus a manifest saying which they are, a
 * spine saying what order to read them in, and a table of contents naming
 * them. All three matter and they say different things: the manifest lists
 * everything in the book including the parts that are never displayed, the
 * spine is the reading order, and only the contents file knows what the
 * chapters are called.
 *
 * Reading the zip in its own order — the obvious shortcut — gets chapters
 * alphabetically, which for any book with more than nine of them puts chapter
 * 10 after chapter 1. The spine exists precisely because file order means
 * nothing, so the spine is what's followed.
 */
export async function extractEpub(data: Buffer, assets: AssetSink): Promise<ExtractResult> {
  const zip = ZipArchive.open(data);
  if (zip.has("META-INF/encryption.xml")) {
    // Font obfuscation also lives in this file, but a reader can't tell the
    // two apart without trying, and the failure to describe is the likely one.
    throw new Error(
      "this EPUB is encrypted (DRM) — its text can't be read without the reader app it was bought from"
    );
  }

  const packagePath = findPackage(zip);
  const packageXml = zip.text(packagePath);
  if (!packageXml) throw new Error(`not a readable EPUB (no package document at ${packagePath})`);

  const opf = parseXml(packageXml);
  const manifest = readManifest(opf, packagePath);
  const spine = readSpine(opf, manifest);
  if (spine.length === 0) throw new Error("this EPUB's spine is empty — there is no reading order to follow");

  const titles = readContents(zip, opf, manifest);
  const warnings: string[] = [];
  const unreadable: string[] = [];
  const unresolvedImages: string[] = [];
  const lines: string[] = [];
  let converted = 0;

  for (const item of spine) {
    const xhtml = zip.text(item.href);
    if (xhtml === null) {
      unreadable.push(item.href);
      continue;
    }

    const chapter = await renderChapter(xhtml, item.href, zip, assets);
    unresolvedImages.push(...chapter.unresolved);
    if (chapter.lines.length === 0) continue;

    // A chapter file that opens with its own heading doesn't need the contents
    // page's name for it as well — that is the same title twice.
    const title = titles.get(item.href);
    if (title && openingHeading(chapter.lines) === null) lines.push("", heading(1, escapeInline(title)), "");
    lines.push("", ...chapter.lines, "");
    converted++;
  }

  if (unreadable.length > 0) {
    warnings.push(
      `${unreadable.length} chapter file${unreadable.length === 1 ? "" : "s"} named in the spine ` +
        `${unreadable.length === 1 ? "is" : "are"} missing from the archive: ${unreadable.join(", ")}.`
    );
  }
  warnings.push(...describeUnusedDocuments(manifest, spine));
  if (unresolvedImages.length > 0) {
    warnings.push(
      assets.enabled
        ? `${unresolvedImages.length} image${unresolvedImages.length === 1 ? "" : "s"} could not be read from the ` +
            `archive: ${[...new Set(unresolvedImages)].slice(0, 6).join(", ")}${unresolvedImages.length > 6 ? ", …" : ""}.`
        : `${unresolvedImages.length} image${
            unresolvedImages.length === 1 ? "" : "s"
          } left out (image extraction is off in settings).`
    );
  }

  return {
    markdown: joinBlocks(lines),
    warnings,
    frontmatter: { ...readMetadata(opf), chapters_converted: `${converted}/${spine.length}` },
  };
}

interface ManifestItem {
  id: string;
  /** Absolute path inside the archive. */
  href: string;
  mediaType: string;
  properties: string;
}

/**
 * The package document's path, from the container. It is the one file at a
 * fixed location in an epub; everything else is wherever the manifest says.
 */
function findPackage(zip: ZipArchive): string {
  const container = zip.text(CONTAINER);
  if (container) {
    for (const rootfile of descendants(parseXml(container), "rootfile")) {
      const path = rootfile.getAttribute("full-path");
      if (path) return path;
    }
  }
  // A malformed container still leaves the package document findable, and one
  // missing chapter of metadata is not a reason to refuse the whole book.
  const guess = zip.paths().find((path) => path.toLowerCase().endsWith(".opf"));
  if (guess) return guess;
  throw new Error("not an EPUB (no META-INF/container.xml and no package document)");
}

function readManifest(opf: Document, packagePath: string): Map<string, ManifestItem> {
  const items = new Map<string, ManifestItem>();
  for (const item of descendants(opf, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    items.set(id, {
      id,
      // Manifest hrefs are relative to the package document, which is often
      // itself in a subfolder — `OEBPS/content.opf` referencing `text/ch1.xhtml`.
      href: resolvePartPath(packagePath, decodeURI(href)),
      mediaType: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") ?? "",
    });
  }
  return items;
}

function readSpine(opf: Document, manifest: Map<string, ManifestItem>): ManifestItem[] {
  const spine: ManifestItem[] = [];
  for (const reference of descendants(opf, "itemref")) {
    const idref = reference.getAttribute("idref");
    const item = idref ? manifest.get(idref) : null;
    // `linear="no"` marks a section a reader shows out of line — pop-up
    // footnotes, a colophon. It's still the book's text, and it's still in
    // reading order here, so it's converted like anything else.
    if (item) spine.push(item);
  }
  return spine;
}

/**
 * Chapter titles, keyed by the file they name.
 *
 * EPUB 3 uses an XHTML navigation document and EPUB 2 a separate NCX file, and
 * plenty of books ship both for compatibility. Either is read, because a
 * chapter's own file usually holds nothing but "Chapter 4" as a styled `div` —
 * the human-readable name lives only in the contents.
 */
function readContents(zip: ZipArchive, opf: Document, manifest: Map<string, ManifestItem>): Map<string, string> {
  const titles = new Map<string, string>();

  const nav = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
  if (nav) {
    const xhtml = zip.text(nav.href);
    if (xhtml) {
      const document = parseHtml(xhtml);
      for (const anchor of Array.from(document.getElementsByTagName("a"))) {
        record(titles, nav.href, anchor.getAttribute("href"), anchor.textContent);
      }
    }
  }

  const ncxId = descendants(opf, "spine")[0]?.getAttribute("toc");
  const ncx = ncxId ? manifest.get(ncxId) : [...manifest.values()].find((item) => item.href.endsWith(".ncx"));
  if (ncx) {
    const xml = zip.text(ncx.href);
    if (xml) {
      for (const point of descendants(parseXml(xml), "navPoint")) {
        const label = point.getElementsByTagName("text").item(0)?.textContent ?? null;
        const src = point.getElementsByTagName("content").item(0)?.getAttribute("src") ?? null;
        record(titles, ncx.href, src, label);
      }
    }
  }

  return titles;
}

function record(titles: Map<string, string>, fromPath: string, href: string | null, label: string | null): void {
  const text = label?.replace(/\s+/g, " ").trim();
  if (!href || !text) return;
  // The fragment points at a heading inside the file; the title belongs to the
  // file, and the first entry naming it is the one that names the chapter.
  const path = resolvePartPath(fromPath, decodeURI(href.split("#")[0]));
  if (path !== "" && !titles.has(path)) titles.set(path, text);
}

async function renderChapter(
  xhtml: string,
  chapterPath: string,
  zip: ZipArchive,
  assets: AssetSink
): Promise<{ lines: string[]; unresolved: string[] }> {
  const document = parseHtml(xhtml);
  const body = documentRoot(document);
  if (!body) return { lines: [], unresolved: [] };

  unwrapSvgImages(document);

  const { images, unresolved } = await resolveImages(collectImageSources(body), assets, (src) => {
    const path = resolvePartPath(chapterPath, decodeURI(src.split("#")[0]));
    const extension = imageExtensionOf(path);
    const data = extension ? zip.bytes(path) : null;
    return data && extension ? ({ data, extension } as ImageBytes) : null;
  });

  return {
    lines: renderHtml(body, {
      images,
      // A link to another file in the book points at something that isn't in
      // the vault, so it can't be followed — but its text is the sentence it
      // was written into, and that stays. External links still work.
      resolveHref: (href) => (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) ? href : null),
    }),
    unresolved: unresolved.map((src) => resolvePartPath(chapterPath, src.split("#")[0])),
  };
}

/**
 * Turns an SVG-wrapped image into a plain one.
 *
 * A cover page is conventionally an `<svg>` holding a single `<image>`, which
 * is how it scales to any screen. The renderer skips SVG entirely — an `svg`
 * element is usually a drawing with no text in it — so without this the cover
 * of most books simply doesn't appear.
 */
function unwrapSvgImages(document: Document): void {
  for (const image of Array.from(document.getElementsByTagName("image"))) {
    const href = image.getAttribute("xlink:href") ?? image.getAttribute("href");
    if (!href) continue;

    let target: Element = image;
    for (let parent = image.parentNode; parent; parent = parent.parentNode) {
      if ((parent as Element).tagName?.toLowerCase() !== "svg") break;
      target = parent as Element;
    }

    const replacement = document.createElement("img");
    replacement.setAttribute("src", href);
    replacement.setAttribute("alt", image.getAttribute("alt") ?? "");
    target.parentNode?.replaceChild(replacement, target);
  }
}

/**
 * XHTML in the manifest that the spine never reads.
 *
 * Almost always the navigation document, which is the contents page and would
 * be a list of links to nothing. Occasionally it is a real section the book's
 * producer left out of the reading order by mistake, and that is worth
 * knowing, so both are named rather than counted.
 */
function describeUnusedDocuments(manifest: Map<string, ManifestItem>, spine: ManifestItem[]): string[] {
  const inSpine = new Set(spine.map((item) => item.href));
  const unused = [...manifest.values()].filter(
    (item) => item.mediaType.includes("html") && !inSpine.has(item.href)
  );
  if (unused.length === 0) return [];

  return [
    `${unused.length} document${unused.length === 1 ? "" : "s"} in the book are not part of its reading order ` +
      `and were not converted: ${unused.map((item) => item.href).join(", ")}. This is normally just the ` +
      "contents page, which would be a list of links to files that aren't in your vault.",
  ];
}

function readMetadata(opf: Document): Record<string, string> {
  const frontmatter: Record<string, string> = {};

  const read = (tag: string) => {
    for (const name of [`dc:${tag}`, tag]) {
      const text = descendants(opf, name)[0]?.textContent?.replace(/\s+/g, " ").trim();
      if (text) return text;
    }
    return null;
  };

  const pairs: [string, string][] = [
    ["title", "title"],
    ["author", "creator"],
    ["publisher", "publisher"],
    ["language", "language"],
    ["published", "date"],
  ];
  for (const [key, tag] of pairs) {
    const value = read(tag);
    if (value) frontmatter[key] = yamlValue(value);
  }

  return frontmatter;
}
