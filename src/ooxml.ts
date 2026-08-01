import { AssetSink, imageExtensionOf } from "./assets";
import { ZipArchive } from "./zip";

/**
 * Shared OOXML plumbing: XML parsing and relationship lookup, both of which
 * work identically across .docx, .pptx and .xlsx.
 */

/**
 * Parses an OOXML part with the platform DOMParser (Obsidian runs in Electron,
 * so this is always available) rather than a bundled XML library.
 *
 * Every lookup in the extractors uses the *prefixed* tag name — `w:p`,
 * `a:t`, `p:pic`. That's deliberate: OOXML writers are consistent about their
 * prefixes, and `getElementsByTagName` matching on the qualified name avoids
 * having to thread namespace URIs through every call.
 */
export function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const error = doc.querySelector("parsererror");
  if (error) throw new Error(`malformed XML in OOXML part: ${error.textContent?.trim() ?? "unknown"}`);
  return doc;
}

/** Direct children with the given qualified tag name (not descendants). */
export function children(parent: Element, tagName: string): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (child.tagName === tagName) out.push(child);
  }
  return out;
}

/** First descendant with the given qualified tag name, or null. */
export function firstDescendant(parent: Element, tagName: string): Element | null {
  return parent.getElementsByTagName(tagName).item(0);
}

export function descendants(parent: Element | Document, tagName: string): Element[] {
  return Array.from(parent.getElementsByTagName(tagName));
}

/**
 * A part's relationships, keyed by rId. OOXML never references another part
 * by path directly — a hyperlink, image, slide or worksheet is always an rId
 * resolved through the sibling `_rels/<part>.rels` file.
 */
export interface Relationship {
  target: string;
  type: string;
  external: boolean;
}

export function readRelationships(zip: ZipArchive, partPath: string): Map<string, Relationship> {
  const relsPath = relationshipPathFor(partPath);
  const rels = new Map<string, Relationship>();
  const xml = zip.text(relsPath);
  if (!xml) return rels;

  for (const rel of descendants(parseXml(xml), "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    rels.set(id, {
      target,
      type: rel.getAttribute("Type") ?? "",
      external: rel.getAttribute("TargetMode") === "External",
    });
  }
  return rels;
}

function relationshipPathFor(partPath: string): string {
  const slash = partPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : partPath.slice(0, slash + 1);
  const name = slash === -1 ? partPath : partPath.slice(slash + 1);
  return `${dir}_rels/${name}.rels`;
}

/**
 * Every relationship id an OOXML part uses to reference a picture, in
 * document order. Both the DrawingML form (`a:blip`, used by every modern
 * Office writer) and the legacy VML form (`v:imagedata`, still produced for
 * pasted screenshots and older documents) point at the image the same way —
 * through a relationship id.
 */
export function imageRelationshipIds(root: Element | Document): string[] {
  const ids: string[] = [];
  for (const blip of descendants(root, "a:blip")) {
    const id = blip.getAttribute("r:embed") ?? blip.getAttribute("r:link");
    if (id) ids.push(id);
  }
  for (const image of descendants(root, "v:imagedata")) {
    const id = image.getAttribute("r:id");
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Writes out the images behind the given relationship ids, returning the
 * Markdown embed for each one that made it.
 *
 * Done as an up-front pass rather than inline during rendering so that the
 * rendering itself stays synchronous: an extractor walks its XML tree once
 * and looks embeds up by id, instead of threading async through every
 * paragraph and run.
 */
export async function saveImages(
  zip: ZipArchive,
  partPath: string,
  rels: Map<string, Relationship>,
  ids: Iterable<string>,
  assets: AssetSink
): Promise<Map<string, string>> {
  const embeds = new Map<string, string>();

  for (const id of new Set(ids)) {
    const rel = rels.get(id);
    if (!rel || rel.external) continue;

    const imagePath = resolvePartPath(partPath, rel.target);
    const extension = imageExtensionOf(imagePath);
    if (!extension) continue;

    const data = zip.bytes(imagePath);
    if (!data) continue;

    const embed = await assets.save(data, extension);
    if (embed) embeds.set(id, embed);
  }

  return embeds;
}

/**
 * Resolves a relationship target (which is relative to the *referencing part's*
 * directory, and may contain `..`) into an absolute archive path.
 */
export function resolvePartPath(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);

  const slash = fromPart.lastIndexOf("/");
  const baseSegments = slash === -1 ? [] : fromPart.slice(0, slash).split("/");
  const segments = [...baseSegments];

  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}
