/**
 * Runs the extractors outside Obsidian, so output can be eyeballed against
 * real files without reloading a vault.
 *
 * Usage: node tools/convert.mjs <file> [...]
 *
 * The extractors expect the DOM globals Obsidian gets from Electron; this
 * shims the two they actually use and otherwise runs the real code.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { DOMParser } from "@xmldom/xmldom";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node tools/convert.mjs <file> [...]");
  process.exit(1);
}

globalThis.DOMParser = DOMParser;
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
  entryPoints: ["src/extractors/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "esnext",
  outfile: bundlePath,
  external: ["obsidian", "pdfjs-dist"],
  define: { __PDF_WORKER_SOURCE__: '""' },
  logLevel: "warning",
});

const { extractorFor } = await import(
  pathToFileURL(bundlePath.startsWith("/") ? bundlePath : join(process.cwd(), bundlePath)).href
);

for (const file of files) {
  const extension = extname(file).slice(1).toLowerCase();
  const extract = extractorFor(extension);
  if (!extract) {
    console.error(`SKIP  ${file} (unsupported .${extension})`);
    continue;
  }

  try {
    const result = await extract(readFileSync(file));
    const target = join(outDir, `${basename(file, extname(file))}.md`);
    writeFileSync(target, result.markdown + "\n");
    console.error(`OK    ${file} → ${target} (${result.markdown.length} chars)`);
    for (const warning of result.warnings) console.error(`      note: ${warning}`);
  } catch (error) {
    console.error(`FAIL  ${file}: ${error.message}`);
  }
}

function patchXmldom() {
  const document = new DOMParser().parseFromString("<r/>", "application/xml");
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
