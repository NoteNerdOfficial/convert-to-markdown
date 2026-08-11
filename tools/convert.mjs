/**
 * Runs the extractors outside Obsidian, so output can be eyeballed against
 * real files without reloading a vault.
 *
 * Usage: node tools/convert.mjs <file> [...]
 *
 * The extractors expect the DOM globals Obsidian gets from Electron; this
 * shims the two they actually use and otherwise runs the real code.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { DOMParser as HtmlDomParser } from "linkedom";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node tools/convert.mjs <file> [...]");
  process.exit(1);
}

// Obsidian's DOMParser handles both XML and HTML; Node has neither, and no
// single package here does both well. xmldom is the closer match for OOXML and
// XHTML parts, and linkedom is the only one that will parse real-world HTML —
// tag soup with unclosed <p> and bare <img> — the way a browser does.
globalThis.DOMParser = class {
  parseFromString(source, type) {
    return type === "text/html"
      ? new HtmlDomParser().parseFromString(source, "text/html")
      : new XmlDomParser().parseFromString(source, type);
  }
};
// Obsidian's lint rules want `window.setTimeout`/`window.clearTimeout` rather
// than the bare global, since a popout window has its own; Node has no
// `window` at all, so this points it at the same timers the bare globals
// already are.
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;

// pdf.js uses Promise.withResolvers, which Obsidian's Electron has but Node
// only gained in 22.
if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}
// @xmldom/xmldom implements the spec's parse-error path as a thrown error
// rather than a <parsererror> element, so querySelector is never reached —
// but Element.prototype.remove and .children aren't implemented either.
patchXmldom();

const outDir = process.env.OUT_DIR ?? ".";
const bundlePath = "node_modules/.cache/convert-harness.mjs";

await esbuild.build({
  entryPoints: ["tools/harness-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "esnext",
  outfile: bundlePath,
  // Both are left external so Node loads the real packages: bundling pdf.js
  // trips an esbuild/private-field incompatibility, and tesseract.js needs
  // its own node build to find the OCR engine.
  external: ["obsidian", "pdfjs-dist", "tesseract.js"],
  define: { __PDF_WORKER_SOURCE__: '""', __TESSERACT_WORKER_SOURCE__: '""' },
  logLevel: "warning",
});

const { extractorFor, createAssetSink, CDN_OCR } = await import(
  pathToFileURL(join(process.cwd(), bundlePath)).href
);

for (const file of files) {
  const extension = extname(file).slice(1).toLowerCase();
  const extract = extractorFor(extension);
  if (!extract) {
    console.error(`SKIP  ${file} (unsupported .${extension})`);
    continue;
  }

  const name = basename(file, extname(file));
  const assetDir = join(outDir, `${name} attachments`);

  try {
    // Mirrors the plugin's progress reporting so the callback shape and the
    // stage names it emits stay verifiable outside Obsidian.
    let lastStage = "";
    const ocr = {
      ...CDN_OCR,
      report: (status, progress) => {
        const line = `${status} — ${Math.round(progress * 100)}%`;
        if (line === lastStage) return;
        lastStage = line;
        if (process.env.OCR_PROGRESS) console.error(`      ${line}`);
      },
    };

    // Bare filename, matching the plugin's own assetSink: createAssetSink
    // already makes assetName vault-unique (it's hash-suffixed), so this is
    // what a real note gets, not a harness-only shortcut.
    const result = await extract(readFileSync(file), createAssetSink(async (data, assetName) => {
      mkdirSync(assetDir, { recursive: true });
      writeFileSync(join(assetDir, assetName), data);
      return `![[${assetName}]]`;
    }), ocr, { includeHiddenSheets: process.env.SKIP_HIDDEN_SHEETS !== "1" });
    const target = join(outDir, `${name}.md`);
    writeFileSync(target, result.markdown + "\n");
    console.error(`OK    ${file} → ${target} (${result.markdown.length} chars)`);
    for (const [key, value] of Object.entries(result.frontmatter ?? {})) {
      console.error(`      ${key}: ${value}`);
    }
    for (const warning of result.warnings) console.error(`      note: ${warning}`);
  } catch (error) {
    console.error(`FAIL  ${file}: ${error.message}`);
  }
}

function patchXmldom() {
  const document = new XmlDomParser().parseFromString("<r/>", "application/xml");
  const elementProto = Object.getPrototypeOf(document.documentElement);
  const documentProto = Object.getPrototypeOf(document);

  if (!("children" in elementProto)) {
    Object.defineProperty(elementProto, "children", {
      get() {
        return Array.from(this.childNodes ?? []).filter((node) => node.nodeType === 1);
      },
    });
  }
  if (typeof elementProto.remove !== "function") {
    elementProto.remove = function remove() {
      this.parentNode?.removeChild(this);
    };
  }
  // parseXml() checks for a <parsererror> element; xmldom throws instead.
  if (typeof documentProto.querySelector !== "function") {
    documentProto.querySelector = () => null;
  }
}
