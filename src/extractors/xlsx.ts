import { ZipArchive } from "../zip";
import {
  children,
  descendants,
  imageRelationshipIds,
  parseXml,
  readRelationships,
  resolvePartPath,
  saveImages,
} from "../ooxml";
import { AssetSink } from "../assets";
import { escapeInline, heading, joinBlocks, table } from "../markdown";
import { OcrProvider } from "../ocr";
import { DEFAULT_EXTRACT_OPTIONS, ExtractOptions, ExtractResult } from "./types";

const WORKBOOK_PART = "xl/workbook.xml";
const SHARED_STRINGS_PART = "xl/sharedStrings.xml";
const STYLES_PART = "xl/styles.xml";

/**
 * .xlsx → one Markdown table per sheet.
 *
 * Two things separate this from a naive dump. First, cell formats: Excel
 * stores a date as a plain number and a displayed `27.38` as
 * 27.383982300884924, with only the *cell format* saying otherwise — without
 * reading styles.xml, every date comes out as a five-digit serial and every
 * computed column as float noise.
 *
 * Second, accounting for every sheet. Hidden is a presentation choice, not a
 * statement about the data — the hidden sheets in a workbook are as often the
 * raw table a visible pivot summarises as they are scratch space — so they're
 * converted like any other, and a reader who turns that off gets the skipped
 * sheets *by name*, plus a coverage count in the frontmatter. Whatever is
 * missing from the note is visible from the top of it.
 */
export async function extractXlsx(
  data: Buffer,
  assets: AssetSink,
  _ocr: OcrProvider,
  options: ExtractOptions = DEFAULT_EXTRACT_OPTIONS
): Promise<ExtractResult> {
  const zip = ZipArchive.open(data);
  const workbookXml = zip.text(WORKBOOK_PART);
  if (!workbookXml) throw new Error("not an Excel workbook (no xl/workbook.xml)");

  const workbook = parseXml(workbookXml);
  const sharedStrings = readSharedStrings(zip);
  const cellFormats = readCellFormats(zip);
  const sheets = readSheetIndex(zip, workbook);

  // Only worth working out when a hidden sheet is actually at risk of being
  // dropped — with the default setting nothing is, so nothing is scanned.
  const loadBearing =
    options.includeHiddenSheets || !sheets.some((sheet) => sheet.hidden)
      ? new Set<string>()
      : loadBearingSheetNames(zip, workbook, sheets);

  const lines: string[] = [];
  const skippedHidden: string[] = [];
  const keptHidden: string[] = [];
  const keptLoadBearing: string[] = [];
  const emptySheets: string[] = [];
  const unreadableSheets: string[] = [];
  let converted = 0;

  for (const sheet of sheets) {
    // Which list a hidden sheet belongs in isn't settled until it turns out to
    // have content: a hidden *and* empty sheet is reported as empty, not as
    // one that was kept.
    let keptDespiteHidden: string[] | null = null;
    if (sheet.hidden) {
      if (options.includeHiddenSheets) keptDespiteHidden = keptHidden;
      else if (loadBearing.has(sheetKey(sheet.name))) keptDespiteHidden = keptLoadBearing;
      else {
        skippedHidden.push(sheet.name);
        continue;
      }
    }

    const sheetXml = sheet.path ? zip.text(sheet.path) : null;
    if (!sheet.path || sheetXml === null) {
      unreadableSheets.push(sheet.name);
      continue;
    }

    const rows = readSheetRows(sheetXml, sharedStrings, cellFormats);
    const embeds = await sheetImages(zip, sheet.path, assets);
    if (rows.length === 0 && embeds.length === 0) {
      emptySheets.push(sheet.name);
      continue;
    }

    converted++;
    keptDespiteHidden?.push(sheet.name);
    // Images float over the grid at pixel offsets rather than living in a
    // cell, so there's no row they belong to — they go after the table.
    lines.push(
      "",
      heading(2, sheet.name),
      "",
      ...table(rows),
      "",
      ...embeds.flatMap((embed) => [embed, ""])
    );
  }

  const warnings: string[] = [];
  // Named, not counted: "18 hidden sheets skipped" tells a reader nothing they
  // can act on, while the names say whether the gap matters.
  if (skippedHidden.length > 0) warnings.push(`Skipped (hidden): ${nameList(skippedHidden)}.`);
  if (emptySheets.length > 0) warnings.push(`Skipped (empty): ${nameList(emptySheets)}.`);
  if (unreadableSheets.length > 0) {
    warnings.push(`Skipped (worksheet part missing from the file): ${nameList(unreadableSheets)}.`);
  }
  if (keptLoadBearing.length > 0) {
    warnings.push(
      `Hidden but converted anyway, because a visible sheet, pivot table or chart reads from them: ${nameList(keptLoadBearing)}.`
    );
  }
  if (keptHidden.length > 0) {
    warnings.push(`Hidden in Excel, converted anyway: ${nameList(keptHidden)}.`);
  }
  warnings.push("Formulas are exported as their last-calculated values.");

  return {
    markdown: joinBlocks(lines),
    warnings,
    frontmatter: { sheets_converted: `${converted}/${sheets.length}` },
  };
}

interface SheetEntry {
  name: string;
  hidden: boolean;
  /** Archive path of the worksheet part, or null if it can't be resolved. */
  path: string | null;
}

/** Every sheet the workbook declares, in tab order, resolved to its part. */
function readSheetIndex(zip: ZipArchive, workbook: Document): SheetEntry[] {
  const rels = readRelationships(zip, WORKBOOK_PART);

  return descendants(workbook, "sheet").map((sheet) => {
    const state = sheet.getAttribute("state");
    const relId = sheet.getAttribute("r:id");
    const rel = relId ? rels.get(relId) : undefined;
    const path = rel && !rel.external ? resolvePartPath(WORKBOOK_PART, rel.target) : null;

    return {
      name: sheet.getAttribute("name") ?? "Sheet",
      hidden: state === "hidden" || state === "veryHidden",
      path: path && zip.has(path) ? path : null,
    };
  });
}

function nameList(names: string[]): string {
  return names.map(escapeInline).join(", ");
}

/** Excel compares sheet names case-insensitively, and so must any lookup. */
function sheetKey(name: string): string {
  return name.trim().toLowerCase();
}

const PIVOT_CACHE_PATTERN = /^xl\/pivotCache\/pivotCacheDefinition[^/]*\.xml$/;
const CHART_PATTERN = /^xl\/charts\/chart[^/]*\.xml$/;
const TABLE_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table";

/**
 * Hidden sheets that the visible ones depend on, as a set of `sheetKey`s.
 *
 * A hidden sheet that a visible formula, a pivot cache or a chart series reads
 * from is load-bearing — that dependency is a far stronger signal about the
 * data than the hidden flag is, so those sheets are converted even when hidden
 * sheets are otherwise being left out. The set is deliberately over-inclusive:
 * a name that resolves to nothing costs nothing, whereas a missing raw-data
 * sheet silently guts the note.
 */
function loadBearingSheetNames(zip: ZipArchive, workbook: Document, sheets: SheetEntry[]): Set<string> {
  const referenced = new Set<string>();
  const named = namedSourceSheets(zip, workbook, sheets);
  const record = (name: string) => {
    referenced.add(name);
    for (const target of named.get(name) ?? []) referenced.add(target);
  };

  for (const sheet of sheets) {
    if (sheet.hidden || !sheet.path) continue;
    const xml = zip.text(sheet.path);
    if (xml) partSheetReferences(xml, "f").forEach(record);
  }

  for (const path of zip.paths()) {
    // A chart keeps its series formulas in its own part, and a pivot table its
    // source in a cache definition — neither is reachable from the sheet XML.
    if (CHART_PATTERN.test(path)) {
      const xml = zip.text(path);
      if (xml) partSheetReferences(xml, "c:f").forEach(record);
      continue;
    }
    if (!PIVOT_CACHE_PATTERN.test(path)) continue;

    const cache = parsePart(zip, path);
    if (!cache) continue;
    for (const source of descendants(cache, "worksheetSource")) {
      // Either a range on a named sheet, or a table / named range that has to
      // be resolved back to the sheet holding it.
      const sheet = source.getAttribute("sheet");
      if (sheet) record(sheetKey(sheet));
      const name = source.getAttribute("name");
      if (name) record(sheetKey(name));
    }
  }

  return referenced;
}

/**
 * Sheets reachable through a name rather than a direct reference: workbook-wide
 * named ranges, and the tables a pivot cache cites by table name.
 */
function namedSourceSheets(
  zip: ZipArchive,
  workbook: Document,
  sheets: SheetEntry[]
): Map<string, string[]> {
  const sources = new Map<string, string[]>();

  for (const definedName of descendants(workbook, "definedName")) {
    const name = definedName.getAttribute("name");
    // Sheet-scoped names and Excel's own built-ins (print areas, filter
    // ranges) describe one sheet's layout rather than a dependency between
    // sheets, so they'd make every hidden sheet look load-bearing.
    if (!name || name.startsWith("_xlnm.") || definedName.getAttribute("localSheetId")) continue;
    sources.set(sheetKey(name), sheetReferencesIn(definedName.textContent ?? ""));
  }

  for (const sheet of sheets) {
    if (!sheet.path) continue;
    for (const rel of readRelationships(zip, sheet.path).values()) {
      if (rel.type !== TABLE_REL_TYPE || rel.external) continue;
      const table = parsePart(zip, resolvePartPath(sheet.path, rel.target))?.documentElement;
      const name = table?.getAttribute("displayName") ?? table?.getAttribute("name");
      if (name) sources.set(sheetKey(name), [sheetKey(sheet.name)]);
    }
  }

  return sources;
}

/**
 * Sheet names referenced by the formulas in a part, read straight off the XML
 * text rather than through the DOM: a worksheet part can hold tens of thousands
 * of rows, and parsing one a second time purely to reach its `<f>` elements
 * costs far more than the scan is worth.
 */
function partSheetReferences(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  const names: string[] = [];
  for (const match of Array.from(xml.matchAll(pattern))) {
    names.push(...sheetReferencesIn(decodeXmlText(match[1])));
  }
  return names;
}

/**
 * The sheet name in front of every `!` in a formula. Quoted names hold the
 * awkward ones (`'raw data (monthly)'!A1`), where an embedded apostrophe is
 * doubled; unquoted ones stop at any character Excel won't allow in a bare
 * name. References into another workbook (`[1]Sheet1!A1`) simply resolve to
 * nothing here, which is the right outcome — they aren't sheets in this file.
 */
const SHEET_REFERENCE = /(?:'((?:[^']|'')*)'|([^\s'"!(),;+*/^&=<>%[\]{}-]+))!/g;

function sheetReferencesIn(formula: string): string[] {
  const names: string[] = [];
  for (const match of Array.from(formula.matchAll(SHEET_REFERENCE))) {
    const reference = match[1] !== undefined ? match[1].replace(/''/g, "'") : match[2];
    // A 3-D reference spans a range of tabs — `Jan:Dec!B4` — and both endpoints
    // name a real sheet. Splitting also picks up the harmless `A1:Sheet2` half
    // of `Sheet1!A1:Sheet2!B2`.
    for (const part of reference.split(":")) {
      if (part !== "") names.push(sheetKey(part));
    }
  }
  return names;
}

function decodeXmlText(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (entity, code: string) => {
    switch (code) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return String.fromCodePoint(Number(code.replace("#x", "0x").replace("#", "")));
    }
  });
}

/** A part as a DOM, or null when it's absent or malformed. */
function parsePart(zip: ZipArchive, path: string): Document | null {
  const xml = zip.text(path);
  if (!xml) return null;
  try {
    return parseXml(xml);
  } catch {
    return null;
  }
}

const DRAWING_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";

/**
 * Images on a worksheet, in the order the drawing part lists them.
 *
 * Excel keeps them out of the sheet entirely: the sheet points at a drawing
 * part, and that part holds the pictures with their own relationships.
 */
async function sheetImages(zip: ZipArchive, sheetPath: string, assets: AssetSink): Promise<string[]> {
  const drawingRel = [...readRelationships(zip, sheetPath).values()].find(
    (rel) => rel.type === DRAWING_REL_TYPE && !rel.external
  );
  if (!drawingRel) return [];

  const drawingPath = resolvePartPath(sheetPath, drawingRel.target);
  const drawingXml = zip.text(drawingPath);
  if (!drawingXml) return [];

  const drawingRels = readRelationships(zip, drawingPath);
  const ids = [...new Set(imageRelationshipIds(parseXml(drawingXml)))];
  const embeds = await saveImages(zip, drawingPath, drawingRels, ids, assets);

  return ids.map((id) => embeds.get(id)).filter((embed): embed is string => embed !== undefined);
}

function readSheetRows(
  sheetXml: string,
  sharedStrings: string[],
  cellFormats: Map<number, CellFormat>
): string[][] {
  const sheetData = parseXml(sheetXml).getElementsByTagName("sheetData").item(0);
  if (!sheetData) return [];

  const rows: string[][] = [];
  let widestRow = 0;

  for (const row of children(sheetData, "row")) {
    const cells: string[] = [];

    for (const cell of children(row, "c")) {
      const columnIndex = columnIndexOf(cell.getAttribute("r"));
      const index = columnIndex >= 0 ? columnIndex : cells.length;
      while (cells.length < index) cells.push("");
      cells[index] = escapeInline(readCellValue(cell, sharedStrings, cellFormats));
    }

    // Rows carry an `r` attribute too, but gaps between them are just blank
    // rows — dropping them keeps the table compact, which is what a reader
    // wants from a note.
    if (cells.some((value) => value !== "")) {
      widestRow = Math.max(widestRow, cells.length);
      rows.push(cells);
    }
  }

  // A row that ended early is shorter than the widest one; the table renderer
  // pads, but trailing all-empty columns should go entirely.
  return trimTrailingEmptyColumns(rows, widestRow);
}

function trimTrailingEmptyColumns(rows: string[][], width: number): string[][] {
  let lastUsed = -1;
  for (let column = 0; column < width; column++) {
    if (rows.some((row) => (row[column] ?? "") !== "")) lastUsed = column;
  }
  if (lastUsed === -1) return [];
  return rows.map((row) => {
    const trimmed = row.slice(0, lastUsed + 1);
    while (trimmed.length < lastUsed + 1) trimmed.push("");
    return trimmed.map((value) => value ?? "");
  });
}

function readCellValue(cell: Element, sharedStrings: string[], cellFormats: Map<number, CellFormat>): string {
  const type = cell.getAttribute("t");

  if (type === "inlineStr") {
    const inline = children(cell, "is")[0];
    return inline ? textOf(inline) : "";
  }

  const raw = children(cell, "v")[0]?.textContent ?? "";
  if (raw === "") return "";

  switch (type) {
    case "s": {
      const index = Number(raw);
      return Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
    }
    case "b":
      return raw === "1" ? "TRUE" : "FALSE";
    case "e": // #REF!, #N/A, … — the error text is the value
    case "str": // cached result of a formula that returns text
      return raw;
  }

  const styleIndex = Number(cell.getAttribute("s") ?? "0");
  const format = cellFormats.get(styleIndex);
  const value = Number(raw);
  if (!format || !Number.isFinite(value)) return raw;

  if (format.isDate) return serialToIsoDate(value) ?? raw;
  return formatNumber(value, format);
}

/**
 * Applies the parts of the cell's number format that change what the value
 * *is* rather than how it's decorated: the percent scaling, and the decimal
 * places. Currency symbols, thousands separators and colour codes are left
 * off deliberately — they're presentation, and they'd fight with Markdown.
 */
function formatNumber(value: number, format: CellFormat): string {
  const scaled = format.isPercent ? value * 100 : value;

  // Excel's own general format shows about 11 significant digits; anything
  // past that in a stored value is float noise from a formula, never data
  // the author typed.
  const rounded =
    format.decimals === null ? Number(scaled.toPrecision(11)) : Number(scaled.toFixed(format.decimals));

  const text = format.decimals === null ? String(rounded) : rounded.toFixed(format.decimals);
  return format.isPercent ? `${text}%` : text;
}

/**
 * Excel stores a date as days since 1899-12-30 (the offset accounts for its
 * deliberate 1900 leap-year bug). Times come through as the fractional part.
 */
function serialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;

  const days = Math.floor(serial);
  const millisecondsInDay = Math.round((serial - days) * 86400) * 1000;
  const date = new Date(Date.UTC(1899, 11, 30) + days * 86400000 + millisecondsInDay);
  if (Number.isNaN(date.getTime())) return null;

  const iso = date.toISOString();
  return millisecondsInDay === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

/** `"BC12"` → 54. Returns -1 when the reference is missing or malformed. */
function columnIndexOf(reference: string | null): number {
  if (!reference) return -1;
  const letters = /^([A-Z]+)/.exec(reference)?.[1];
  if (!letters) return -1;

  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * The shared string table: Excel deduplicates every string in the workbook
 * into this one part and stores only indices in the cells.
 */
function readSharedStrings(zip: ZipArchive): string[] {
  const xml = zip.text(SHARED_STRINGS_PART);
  if (!xml) return [];
  return descendants(parseXml(xml), "si").map(textOf);
}

/** A string item's text, concatenating its formatting runs. */
function textOf(element: Element): string {
  // `rPh` holds phonetic (furigana) hints that duplicate the reading of the
  // main text — including them would double up every Japanese cell.
  for (const phonetic of Array.from(element.getElementsByTagName("rPh"))) {
    phonetic.remove();
  }
  return descendants(element, "t")
    .map((node) => node.textContent ?? "")
    .join("");
}

interface CellFormat {
  isDate: boolean;
  isPercent: boolean;
  /** Decimal places the format asks for, or null for Excel's General format. */
  decimals: number | null;
}

/**
 * What each style index means, keyed by position in `cellXfs` — which is what
 * a cell's `s` attribute points at. The style names a `numFmtId`, which is
 * either one of Excel's built-ins or defined in the workbook's own `numFmts`.
 */
function readCellFormats(zip: ZipArchive): Map<number, CellFormat> {
  const formats = new Map<number, CellFormat>();
  const xml = zip.text(STYLES_PART);
  if (!xml) return formats;

  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    return formats;
  }

  const customCodes = new Map<number, string>();
  for (const format of descendants(doc, "numFmt")) {
    const id = Number(format.getAttribute("numFmtId"));
    const code = format.getAttribute("formatCode");
    if (Number.isInteger(id) && code) customCodes.set(id, code);
  }

  const cellXfs = doc.getElementsByTagName("cellXfs").item(0);
  if (!cellXfs) return formats;

  children(cellXfs, "xf").forEach((xf, index) => {
    const numFmtId = Number(xf.getAttribute("numFmtId") ?? "0");
    if (!Number.isInteger(numFmtId)) return;
    formats.set(index, interpretFormat(numFmtId, customCodes.get(numFmtId)));
  });

  return formats;
}

function interpretFormat(numFmtId: number, code: string | undefined): CellFormat {
  if (isBuiltInDateFormat(numFmtId)) return { isDate: true, isPercent: false, decimals: null };
  if (code === undefined) return builtInNumericFormat(numFmtId);

  // Strip literal text, escapes and locale/colour codes before inspecting —
  // a currency format like `"Day"#,##0` shouldn't read as a date just because
  // it spells one, and `[Red]` shouldn't contribute a `d`.
  const bare = code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  // Only the first section of a `positive;negative;zero;text` format applies
  // to the values that reach here.
  const section = bare.split(";")[0];

  if (/[ymdhs]/i.test(section)) return { isDate: true, isPercent: false, decimals: null };

  return {
    isDate: false,
    isPercent: section.includes("%"),
    decimals: decimalPlacesIn(section),
  };
}

/** Built-in ids reserved for date and time formats by the OOXML spec. */
function isBuiltInDateFormat(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
}

/**
 * The handful of built-in numeric ids worth honouring. The rest fall through
 * to General, which is the right default anyway.
 */
function builtInNumericFormat(id: number): CellFormat {
  switch (id) {
    case 1: // 0
    case 3: // #,##0
      return { isDate: false, isPercent: false, decimals: 0 };
    case 2: // 0.00
    case 4: // #,##0.00
    case 7:
    case 8: // currency with cents
    case 39:
    case 40:
    case 43:
    case 44: // accounting
      return { isDate: false, isPercent: false, decimals: 2 };
    case 9: // 0%
      return { isDate: false, isPercent: true, decimals: 0 };
    case 10: // 0.00%
      return { isDate: false, isPercent: true, decimals: 2 };
    default:
      return { isDate: false, isPercent: false, decimals: null };
  }
}

function decimalPlacesIn(section: string): number | null {
  const fraction = /\.([0#?]+)/.exec(section);
  if (fraction) return fraction[1].length;
  // A format with an integer placeholder but no decimal point means whole
  // numbers; one with neither is General.
  return /[0#?]/.test(section) ? 0 : null;
}
