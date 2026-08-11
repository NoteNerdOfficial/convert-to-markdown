import { AssetSink } from "../assets";
import { collectImageSources, findMainContent, parseHtml, renderHtml, resolveImages } from "../html";
import { alreadyTitled, escapeInline, heading, joinBlocks, yamlValue } from "../markdown";
import { decodeEntities, decodeText } from "../text";
import { ExtractResult } from "./types";

/**
 * .html / .htm → Markdown.
 *
 * The hard part of a saved web page isn't the markup, it's deciding what the
 * page *is*. A single-file save of an article carries the article and also the
 * site's navigation, a cookie banner, a subscribe box, a sidebar of related
 * stories and a footer with the whole site map — usually more words than the
 * article. Converting all of it produces a note where the content is buried in
 * the middle of somebody's menu.
 *
 * So the page's own structural markers pick out the content, and what that
 * left behind is reported rather than quietly dropped, because the detection
 * is a heuristic and a reader has to be able to tell when it misfired.
 */
export async function extractHtml(data: Buffer, assets: AssetSink): Promise<ExtractResult> {
  const source = decodeText(data, declaredCharset(data));
  const document = parseHtml(source);
  const { root, dropped } = findMainContent(document);
  if (!root) throw new Error("the file has no <body> — it may not be HTML");

  const { images, unresolved } = await resolveImages(collectImageSources(root), assets, () => null);
  const lines = renderHtml(root, { images });

  const title = pageTitle(document);
  // The `<title>` is the page's name, not part of its text, and a well-formed
  // article repeats it as its own `<h1>`. Adding it unconditionally would give
  // half of all pages the same heading twice.
  if (title && !alreadyTitled(lines, title)) lines.unshift(heading(1, escapeInline(title)), "");

  return {
    markdown: joinBlocks(lines),
    warnings: describeGaps(dropped, unresolved, assets),
    frontmatter: frontmatterFor(document, title),
  };
}

/**
 * The charset from the document's own `<meta>`, read from the raw bytes.
 *
 * Circular by nature — the declaration that says how to decode the file is
 * inside the file — which is why browsers read it as ASCII from the first few
 * kilobytes and so does this. A page saved from a non-UTF-8 site is otherwise
 * decoded as UTF-8, fails, and falls back to a guess when the answer was
 * written down in the first line.
 */
function declaredCharset(data: Buffer): string | null {
  const head = data.subarray(0, 4096).toString("latin1");
  const meta =
    /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_:.-]+)/i.exec(head) ??
    /<\?xml[^>]+encoding\s*=\s*["']([A-Za-z0-9_:.-]+)["']/i.exec(head);
  return meta ? meta[1] : null;
}

function pageTitle(document: Document): string | null {
  const title = document.getElementsByTagName("title").item(0)?.textContent?.trim();
  if (title) return decodeEntities(title).replace(/\s+/g, " ");
  const h1 = document.getElementsByTagName("h1").item(0)?.textContent?.trim();
  return h1 ? h1.replace(/\s+/g, " ") : null;
}

/**
 * The metadata a page states about itself. Only the handful that survive as
 * facts about the document — who wrote it, when, and where it came from — not
 * the dozens of tags describing how it should look when shared.
 */
function frontmatterFor(document: Document, title: string | null): Record<string, string> {
  const frontmatter: Record<string, string> = {};
  if (title) frontmatter.title = yamlValue(title);

  const meta = (selector: string) => {
    for (const element of Array.from(document.getElementsByTagName("meta"))) {
      const name = (element.getAttribute("name") ?? element.getAttribute("property") ?? "").toLowerCase();
      if (name === selector) {
        const content = element.getAttribute("content")?.trim();
        if (content) return content;
      }
    }
    return null;
  };

  const url = meta("og:url") ?? canonicalHref(document);
  if (url) frontmatter.url = yamlValue(url);
  const author = meta("author") ?? meta("article:author");
  if (author) frontmatter.author = yamlValue(author);
  const published = meta("article:published_time") ?? meta("date");
  if (published) frontmatter.published = yamlValue(published);

  return frontmatter;
}

function canonicalHref(document: Document): string | null {
  for (const link of Array.from(document.getElementsByTagName("link"))) {
    if ((link.getAttribute("rel") ?? "").toLowerCase() === "canonical") {
      const href = link.getAttribute("href")?.trim();
      if (href) return href;
    }
  }
  return null;
}

function describeGaps(dropped: string[], unresolved: string[], assets: AssetSink): string[] {
  const warnings: string[] = [];

  if (dropped.length > 0) {
    warnings.push(
      `Page furniture left out: ${dropped.join(", ")}. If the article itself is missing, it was inside one of these.`
    );
  }

  const remote = unresolved.filter((src) => /^https?:\/\//i.test(src));
  const local = unresolved.filter((src) => !/^https?:\/\//i.test(src));

  if (remote.length > 0) {
    warnings.push(
      `${remote.length} image${remote.length === 1 ? "" : "s"} ${remote.length === 1 ? "is" : "are"} linked to the ` +
        "web rather than stored in the file, so nothing could be copied into the vault — they are embedded as " +
        "links and will only display online."
    );
  }
  if (local.length > 0) {
    warnings.push(
      assets.enabled
        ? `${local.length} image${local.length === 1 ? "" : "s"} live beside the HTML file rather than inside it ` +
            `(${local.slice(0, 5).join(", ")}${local.length > 5 ? ", …" : ""}) and could not be read. A ` +
            "single-file save (.mhtml) keeps them with the page."
        : `${local.length} image${local.length === 1 ? "" : "s"} left out (image extraction is off in settings).`
    );
  }

  return warnings;
}
