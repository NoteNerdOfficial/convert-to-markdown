/**
 * Tables recovered from where text sits on a page.
 *
 * Shared by everything that reads a page as positioned text rather than as
 * structure: a PDF's glyph runs, and — through OCR — the words in a scan or a
 * photo. Neither has any notion of a table. A PDF table is glyphs at
 * coordinates, sometimes with lines drawn near them; a scanned one is pixels.
 * What survives in both is alignment: the cells of a column line up, and
 * nothing in the rows of a table ever puts ink in the space between two
 * columns.
 *
 * That second fact is what this works from. Splitting a line at "wide" gaps
 * can't find columns on its own — a browser sets the amount columns of a tight
 * invoice table a third of an em apart, narrower than a word space — but a
 * strip that *no* row of a block crosses is a column boundary however narrow
 * it is, and prose never has one, because word spaces fall somewhere
 * different on every line.
 *
 * The rule throughout is to leave text as text unless the table is
 * convincing. A missed table reads as a run of words, which is what the note
 * had before; an invented one scrambles text that was fine.
 */

/** A run of text on one baseline: a pdf.js text item, or an OCR word. */
export interface LayoutItem {
  text: string;
  x: number;
  width: number;
  /** Glyph height, the unit every tolerance here is measured in. */
  size: number;
}

/** The items sharing one baseline, left to right. */
export interface LayoutRow {
  items: LayoutItem[];
  /** Baseline position, growing *down* the page whatever the source's own convention. */
  y: number;
}

export interface DetectedTable {
  /** Index of the table's first row in the rows passed in. */
  first: number;
  /** Index of its last row, inclusive. */
  last: number;
  /** Cell text, first row first. Markdown makes the first row the header. */
  rows: string[][];
  /** Per column: whether it holds numbers, which Markdown then right-aligns. */
  numeric: boolean[];
  left: number;
  right: number;
}

/**
 * Items closer than this, as a fraction of their height, belong to the same
 * run of text. It's the same figure `joinItems` uses to decide a gap was a
 * space, so anything wider than a space can be a cell boundary.
 */
const SPACE_GAP = 0.2;

/**
 * Rows further apart than this, in multiples of the larger row's text
 * height, aren't neighbouring rows of one table — unless the gap repeats.
 * Table rows are usually padded by less than this, and the first row sits a
 * little further below a header that wraps over several lines. Some writers
 * pad every row by far more (LibreOffice sets them nearly three lines
 * apart), and what gives a table away then is that every row is the same
 * distance from the next, which the gap before a table and after it rarely
 * are.
 */
const MAX_ROW_GAP = 2.5;

/**
 * A gap up to this multiple of the one before it is the step from a header
 * to its first row, not a break. Measured against the lines above rather
 * than in ems, since a writer setting small type with open leading spaces
 * everything wider.
 */
const HEADER_STEP = 1.8;

/** Neighbouring lines this many times apart in size aren't one table. */
const SIZE_JUMP = 1.3;

/** Two gaps within this fraction of each other are the same row pitch. */
const SAME_PITCH = 0.15;

/**
 * How many rows either side to look for a gap matching this one. Not just
 * the next: a row whose description wraps puts a line's leading between
 * two of the table's real row gaps.
 */
const PITCH_REACH = 3;

/**
 * How far below the line above a line can sit and still be part of the same
 * row — the second line of a wrapped cell, or a cell set vertically centred
 * against one. Ordinary leading is just over 1; a table's row pitch, padding
 * included, is reliably more than this.
 */
const SAME_ROW_GAP = 1.2;

/**
 * How much larger than the leading inside a cell the gap between rows has to
 * be before the two can be told apart.
 */
const ROW_PITCH_STEP = 1.2;

/** How far apart, in ems, two left edges can be and still be one alignment. */
const SAME_LEFT = 0.5;

/**
 * A gutter narrower than this, in ems, is two gaps that happen to overlap.
 * It has to be small: a browser will set a header's right-aligned "Amount"
 * barely a point clear of the column of prices beside it.
 */
const MIN_GUTTER = 0.1;

/**
 * Two pieces of one row this far apart, in ems, are two cells. If they land
 * in the same column of a table, the row has columns of its own and isn't
 * one of the table's rows — a totals block set flush left under the
 * description column, say.
 */
const CELL_GAP = 1;

/** A column whose lines typically hold this many words is running text. */
const PROSE_WORDS = 4;

/** A column with this share of cells starting in lowercase is a sentence split at a false gutter. */
const PROSE_LOWERCASE = 0.6;

/**
 * Header plus two rows: anything less is a pair of lines, not a table —
 * except a summary, a header over a single row of figures (see isSummary).
 */
const MIN_ROWS = 3;

/**
 * How many rows with several cells a block may shed at each end looking for
 * the table in it. Lines of a single piece at the ends are shed for free,
 * since a table never starts or ends with one.
 */
const MAX_TRIM = 3;

/**
 * A two-column block is only a table when its right-hand column is numbers —
 * a receipt, an invoice's totals. Two columns of words is far more often a
 * two-column page, or labels beside values, both of which read better as
 * text.
 */
const TWO_COLUMN_NUMERIC_SHARE = 0.8;

/** A column counts as numeric, and is right-aligned, past this share of numbers. */
const NUMERIC_COLUMN_SHARE = 0.6;

export function findTables(rows: LayoutRow[]): DetectedTable[] {
  const tables: DetectedTable[] = [];
  const search = (start: number, end: number) => {
    if (end - start + 1 < MIN_ROWS) return;
    const table = bestTable(rows, start, end);
    if (!table) {
      // Nothing holds up across the whole block, which can mean two tables
      // too close together to keep apart — a receipt's items and its
      // totals, aligned differently. The widest gap is the likeliest seam.
      const seam = widestGap(rows, start, end);
      search(start, seam - 1);
      search(seam, end);
      return;
    }
    // A block can hold more than one table — line items with the totals
    // set close beneath them in columns of their own.
    search(start, table.first - 1);
    tables.push(table);
    search(table.last + 1, end);
  };
  for (const [start, end] of blocks(rows)) search(start, end);
  return tables;
}

/**
 * Joins the items on one line, inserting a space where the horizontal gap says
 * there was one. PDF writers split a line into runs wherever the font or
 * kerning changes, so the item boundaries themselves mean nothing.
 */
export function joinItems(items: LayoutItem[]): string {
  let out = items[0].text;
  let cursor = items[0].x + items[0].width;

  for (const item of items.slice(1)) {
    const gap = item.x - cursor;
    const needsSpace = gap > item.size * SPACE_GAP && !/\s$/.test(out) && !/^\s/.test(item.text);
    out += needsSpace ? ` ${item.text}` : item.text;
    cursor = item.x + item.width;
  }
  return out;
}

interface Segment {
  items: LayoutItem[];
  left: number;
  right: number;
}

/** A row's visible items, split wherever a gap is wider than a space. */
function segmentsOf(row: LayoutRow): Segment[] {
  const segments: Segment[] = [];
  for (const item of row.items) {
    if (item.text.trim() === "") continue;
    const last = segments[segments.length - 1];
    if (last && item.x - last.right <= item.size * SPACE_GAP) {
      last.items.push(item);
      last.right = Math.max(last.right, item.x + item.width);
    } else {
      segments.push({ items: [item], left: item.x, right: item.x + item.width });
    }
  }
  return segments;
}

function rowSize(row: LayoutRow): number {
  return Math.max(...row.items.map((item) => item.size));
}

/**
 * Runs of rows close enough together to be one block, holding at least two
 * rows with more than one segment — the only places a table could be.
 */
function blocks(rows: LayoutRow[]): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;

  const close = (end: number) => {
    let multi = 0;
    for (let index = start; index <= end; index++) if (segmentsOf(rows[index]).length > 1) multi++;
    if (multi >= 2) out.push([start, end]);
  };

  const gap = (index: number) => (index > 0 && index < rows.length ? rows[index].y - rows[index - 1].y : NaN);
  const samePitch = (a: number, b: number) => Math.abs(a - b) <= SAME_PITCH * Math.max(a, b);
  const repeats = (index: number) => {
    for (let offset = 1; offset <= PITCH_REACH; offset++) {
      if (samePitch(gap(index), gap(index - offset)) || samePitch(gap(index), gap(index + offset))) return true;
    }
    return false;
  };

  for (let index = 1; index <= rows.length; index++) {
    const ended =
      index === rows.length ||
      sizeJump(rows[index - 1], rows[index]) ||
      (gap(index) > MAX_ROW_GAP * Math.max(rowSize(rows[index]), rowSize(rows[index - 1])) &&
        !(gap(index) <= HEADER_STEP * gap(index - 1)) &&
        !repeats(index));
    if (!ended) continue;
    close(index - 1);
    start = index;
  }
  return out;
}

/**
 * Whether one of two neighbouring lines is a heading: a single run of text
 * clearly larger than the line beside it. A table is set in one size, and
 * whatever sits above a heading — an address block that happens to line up
 * with the columns below — belongs to something else. A larger line with
 * several runs in it is left alone: it's a table's header row, often bold or
 * capitals, and OCR's measure of size swings with both.
 */
function sizeJump(above: LayoutRow, below: LayoutRow): boolean {
  const [larger, smaller] = rowSize(above) >= rowSize(below) ? [above, below] : [below, above];
  return segmentsOf(larger).length === 1 && rowSize(larger) >= SIZE_JUMP * rowSize(smaller);
}

/** Index of the row below the widest gap in a block, relative to text size. */
function widestGap(rows: LayoutRow[], start: number, end: number): number {
  let seam = start + 1;
  let widest = -1;
  for (let index = start + 1; index <= end; index++) {
    const gap = (rows[index].y - rows[index - 1].y) / Math.max(rowSize(rows[index]), rowSize(rows[index - 1]));
    if (gap > widest) {
      widest = gap;
      seam = index;
    }
  }
  return seam;
}

/**
 * The largest table in a block, if any.
 *
 * A block is often more than its table: the line introducing it, a heading
 * set close above, a total underneath. Lines like that cross the table's
 * gutters and so stop any being found. Shedding up to a few rows from each end
 * and keeping the largest result that holds up finds the table inside without
 * needing to know in advance which lines are the strays.
 */
function bestTable(rows: LayoutRow[], start: number, end: number): DetectedTable | null {
  const multi: number[] = [];
  for (let index = start; index <= end; index++) if (segmentsOf(rows[index]).length > 1) multi.push(index);

  let best: DetectedTable | null = null;
  for (let top = 0; top <= MAX_TRIM && top < multi.length; top++) {
    for (let bottom = 0; bottom <= MAX_TRIM && bottom < multi.length - top; bottom++) {
      const first = multi[top];
      const last = multi[multi.length - 1 - bottom];
      if (last - first + 1 < MIN_ROWS) continue;
      const table = tableIn(rows, first, last, start, end);
      if (table && (!best || table.last - table.first > best.last - best.first)) best = table;
    }
  }
  return best;
}

function tableIn(
  rows: LayoutRow[],
  first: number,
  last: number,
  blockStart: number,
  blockEnd: number
): DetectedTable | null {
  // The ends must be rows with cells in them. A one-segment line at either
  // edge is the caption or total around the table, never part of it — the
  // columns are found from the rows that have several cells.
  if (segmentsOf(rows[first]).length < 2 || segmentsOf(rows[last]).length < 2) return null;

  const size = median(rows.slice(first, last + 1).map(rowSize));
  const candidates = rows.slice(first, last + 1).map(segmentsOf);
  let gutters = withoutLoneColumns(
    candidates,
    guttersOf(
      candidates.filter((row) => row.length > 1),
      size
    )
  );
  if (gutters.length === 0) return null;

  // A table starts and ends with rows of at least two cells, so the span is
  // pulled in to the outermost rows that have them. Having several pieces
  // isn't enough: where a PDF sets each word as its own piece, a centred
  // "Thank you!" under a receipt is two pieces in one column, and a totals
  // block under the line items has columns of its own that aren't these.
  // The first row is the header, and a header labels most of the columns: a
  // "Closing balance: $1,902.66" line just above a statement fills two of
  // its five.
  const cellsIn = (index: number) => place(segmentsOf(rows[index]), gutters)?.size ?? 0;
  const columnCount = gutters.length + 1;
  while (first < last && cellsIn(first) < Math.max(2, Math.ceil(columnCount / 2))) first++;
  while (last > first && cellsIn(last) < 2) last--;
  if (last - first + 1 < MIN_ROWS) return null;

  // With the columns known, a single line hard against either end can still
  // belong: above, the first half of a two-line header cell; below, the last
  // line of a description that wrapped — which starts where the cell above
  // it starts, as a centred "Thank you!" under a receipt doesn't.
  const fits = (index: number) => place(segmentsOf(rows[index]), gutters) !== null;
  const wrapsFrom = (index: number) => {
    const above = segmentsOf(rows[index - 1]);
    return segmentsOf(rows[index]).every((segment) =>
      above.some(
        (cell) =>
          columnOf(cell, gutters) === columnOf(segment, gutters) && Math.abs(cell.left - segment.left) <= SAME_LEFT * size
      )
    );
  };
  while (first > blockStart && rows[first].y - rows[first - 1].y <= SAME_ROW_GAP * size && fits(first - 1)) first--;
  while (
    last < blockEnd &&
    rows[last + 1].y - rows[last].y <= SAME_ROW_GAP * size &&
    fits(last + 1) &&
    wrapsFrom(last + 1)
  ) {
    last++;
  }

  const span = rows.slice(first, last + 1);
  const segments = span.map(segmentsOf);
  gutters = withoutLoneColumns(segments, gutters);
  if (gutters.length === 0) return null;

  const columns = gutters.length + 1;
  const placed: { y: number; cells: Map<number, Segment[]> }[] = [];
  for (let index = 0; index < span.length; index++) {
    const cells = place(segments[index], gutters);
    if (cells === null) {
      // The table ends at a row that doesn't follow its columns. What came
      // before may still be a table on its own, ending at its last full row.
      let end = first + index - 1;
      while (end > first && segmentsOf(rows[end]).length < 2) end--;
      // Ending the block there stops the retry growing back over this row.
      return end - first + 1 >= MIN_ROWS ? tableIn(rows, first, end, blockStart, end) : null;
    }
    placed.push({ y: span[index].y, cells });
  }

  const table = mergeRows(placed, columns, size);
  if (table.length < MIN_ROWS && !isSummary(table)) return null;

  const numeric = Array.from({ length: columns }, (_, column) => isNumericColumn(table.slice(1), column));
  if (columns === 2 && !mostlyNumeric(table.slice(1), 1, TWO_COLUMN_NUMERIC_SHARE)) return null;
  // A column holding a single cell is a stray alignment, not a column —
  // unless it's a row's label at the table's edge.
  for (let column = 0; column < columns; column++) {
    const filled = table.filter((row) => row[column] !== "");
    if (filled.length >= 2) continue;
    const others = filled.length === 1 ? filled[0].filter((cell) => cell !== "").length - 1 : 0;
    if (!isRowLabel(column, columns, others)) return null;
  }
  if (looksLikeProse(placed, columns)) return null;

  return {
    first,
    last,
    rows: table,
    numeric,
    left: Math.min(...segments.flat().map((segment) => segment.left)),
    right: Math.max(...segments.flat().map((segment) => segment.right)),
  };
}

/**
 * Column boundaries: the strips between the block's left and right edges
 * that none of its rows put ink on, as [left, right] pairs.
 */
function guttersOf(rows: Segment[][], size: number): [number, number][] {
  const covered = rows
    .flat()
    .map((segment): [number, number] => [segment.left, segment.right])
    .sort((a, b) => a[0] - b[0]);

  const gutters: [number, number][] = [];
  let reach = covered[0][1];
  for (const [left, right] of covered.slice(1)) {
    if (left - reach >= MIN_GUTTER * size) gutters.push([reach, left]);
    reach = Math.max(reach, right);
  }
  return gutters;
}

/**
 * Drops gutters that only carve off a column of one row.
 *
 * A centred header cell can sit a couple of points clear of the column it
 * heads — "Qty" over a column of single digits — and so open a gutter that
 * every other row respects by accident. A column with only one row in it
 * isn't a column, so it's folded into its nearer neighbour: whichever
 * gutter beside it is narrower is the one that was never real.
 */
function withoutLoneColumns(segments: Segment[][], gutters: [number, number][]): [number, number][] {
  const kept = [...gutters];
  for (;;) {
    const columns = kept.length + 1;
    const used = segments.map(
      (row) => new Set(row.map((segment) => columnOf(segment, kept)).filter((column): column is number => column !== null))
    );
    const lone = Array.from({ length: columns }, (_, column) => column).findIndex((column) => {
      const rows = used.filter((row) => row.has(column));
      return rows.length < 2 && !(rows.length === 1 && isRowLabel(column, columns, rows[0].size - 1));
    });
    if (lone === -1 || kept.length === 0) return kept;

    const width = (gutter: [number, number] | undefined) => (gutter ? gutter[1] - gutter[0] : Infinity);
    const before = kept[lone - 1];
    const after = kept[lone];
    kept.splice(width(before) <= width(after) ? lone - 1 : lone, 1);
  }
}

/**
 * A row's segments by column, or null when the row doesn't follow the
 * table's columns: a segment runs right across a gutter, or two segments
 * share a column with a cell's width of space between them.
 */
function place(segments: Segment[], gutters: [number, number][]): Map<number, Segment[]> | null {
  const cells = new Map<number, Segment[]>();
  for (const segment of segments) {
    const column = columnOf(segment, gutters);
    if (column === null) return null;
    const before = cells.get(column);
    const previous = before?.[before.length - 1];
    if (previous && segment.left - previous.right > CELL_GAP * segment.items[0].size) return null;
    cells.set(column, [...(before ?? []), segment]);
  }
  return cells;
}

/**
 * A header over one row of figures: an invoice's tax summary, a statement's
 * balances. Two lines of text practically never line up across three
 * columns with numbers in two of them, so this is safe to accept below the
 * usual minimum.
 */
function isSummary(table: string[][]): boolean {
  return table.length === 2 && table[0].length >= 3 && table[1].filter(isNumeric).length >= 2;
}

/**
 * Whether a column that only one row uses is that row's label: at the edge of
 * the table, beside cells of the row in at least two of its other columns. A
 * summary table's "Total" is set to the left of the column it totals, under
 * no header at all.
 */
function isRowLabel(column: number, columns: number, otherCells: number): boolean {
  return (column === 0 || column === columns - 1) && otherCells >= 2;
}

/**
 * The column a segment sits in, or null when it runs right across a gutter.
 *
 * A segment may reach *into* a gutter without crossing it. Gutters are found
 * from the rows with several cells, and a line of a wrapped description is
 * free to run further right than any of them did — it's still in its column
 * as long as it stops short of the next one.
 */
function columnOf(segment: Segment, gutters: [number, number][]): number | null {
  const middle = (segment.left + segment.right) / 2;
  let column = 0;
  for (const [left, right] of gutters) {
    if (segment.left < left && segment.right > right) return null;
    if (middle > (left + right) / 2) column++;
  }
  return column;
}

/**
 * Folds baselines into table rows.
 *
 * One table row can span several baselines: a description that wraps onto a
 * second line, or — the way a browser sets a table — the short cells of a row
 * centred vertically against a tall one, so the quantity and price sit on a
 * baseline of their own between the description's two lines. A baseline joins
 * the row above when it's close enough to be part of it and either fills only
 * cells that row left empty, or adds wrapped lines to cells of words. A
 * baseline that brings a number into a cell that already has one is the next
 * row.
 *
 * What counts as close enough comes from the table itself where it can. A
 * table whose cells wrap shows two kinds of gap between baselines — the
 * leading inside a cell, and the padding between rows — and the line between
 * them is exact for that table, where no fixed figure is: one writer sets a
 * wrapped cell's lines further apart than another sets its rows. There,
 * every line of a multi-line header lands in the header, however many
 * columns it spans. A table with only one kind of gap has no wrapped cells
 * to learn from, and falls back to a fixed limit and a stricter test: only a
 * baseline filling few of the columns can be a wrapped line.
 */
function mergeRows(placed: { y: number; cells: Map<number, Segment[]> }[], columns: number, size: number): string[][] {
  const rows: { y: number; cells: string[] }[] = [];
  const leading = leadingLimit(placed.map((row) => row.y));

  for (const { y, cells } of placed) {
    const texts = new Map([...cells].map(([column, segments]) => [column, segments.map((s) => joinItems(s.items)).join(" ")]));
    const current = rows[rows.length - 1];
    const near = current !== undefined && y - current.y <= (leading ?? SAME_ROW_GAP * size);

    if (current && near) {
      // Only what lands in an already-filled cell has to read as a wrapped
      // line; figures filling the row's empty cells are the rest of it.
      const shared = [...texts].filter(([column]) => current.cells[column] !== "");
      const partial = leading !== null || texts.size <= Math.ceil(columns / 2);
      const words = shared.every(([, text]) => !isNumeric(text));
      if (shared.length === 0 || (partial && words)) {
        for (const [column, text] of texts) current.cells[column] = joinWrapped(current.cells[column], text);
        current.y = y;
        continue;
      }
    }

    const row = Array<string>(columns).fill("");
    for (const [column, text] of texts) row[column] = text;
    rows.push({ y, cells: row });
  }

  return rows.map((row) => row.cells.map((cell) => cell.replace(/\s+/g, " ").trim()));
}

/**
 * The largest gap between baselines that's still a line inside a cell, when
 * the table's gaps fall into two clear groups — or null when they don't.
 */
function leadingLimit(baselines: number[]): number | null {
  const gaps = baselines
    .slice(1)
    .map((y, index) => y - baselines[index])
    .sort((a, b) => a - b);
  let best: number | null = null;
  let widest = ROW_PITCH_STEP;
  for (let index = 1; index < gaps.length; index++) {
    const step = gaps[index] / gaps[index - 1];
    if (step >= widest) {
      widest = step;
      best = (gaps[index] + gaps[index - 1]) / 2;
    }
  }
  return best;
}

/** Rejoins a wrapped cell, undoing hyphenation that only existed to fit the column. */
function joinWrapped(above: string, below: string): string {
  if (above === "") return below;
  if (/[‐-]$/.test(above)) return `${above.slice(0, -1)}${below.trimStart()}`;
  return `${above} ${below}`;
}

/**
 * Whether a block that lines up like a table is really running text.
 *
 * Text in columns has gutters no row crosses, exactly like a table: a
 * three-column newsletter, or — worse — monospaced prose, where every
 * character sits on a grid and the spaces between words line up down the
 * page by coincidence. Two things give it away. Running text puts several
 * words on each line of a column, where a table has at most one column of
 * descriptions and short cells beside it. And a sentence split at a false
 * gutter carries on in lowercase on the far side, which a table's cells
 * almost never begin with.
 */
function looksLikeProse(placed: { cells: Map<number, Segment[]> }[], columns: number): boolean {
  let wordy = 0;
  for (let column = 0; column < columns; column++) {
    const texts = placed
      .map((row) => row.cells.get(column))
      .filter((cell): cell is Segment[] => cell !== undefined)
      .map((cell) => cell.map((segment) => joinItems(segment.items)).join(" ").trim());
    if (texts.length === 0) continue;

    if (median(texts.map((text) => text.split(/\s+/).length)) >= PROSE_WORDS) wordy++;
    if (column > 0 && texts.filter((text) => /^\p{Ll}/u.test(text)).length >= texts.length * PROSE_LOWERCASE) {
      return true;
    }
  }
  return wordy >= 2;
}

/**
 * Amounts, quantities and percentages, with the currency marks and signs
 * invoices and statements put around them: `$1,469.00 CAD`, `−$11.30`,
 * `(45.00)`, `13%`. Dates and times are deliberately not numbers here — a
 * column of them reads left to right like text.
 */
const NUMBER = /^[-−–+(]?\s*[$€£¥₹]?\s*[-−]?\d[\d,.' ]*%?\)?(\s?[A-Z]{3})?$/;

function isNumeric(text: string): boolean {
  return NUMBER.test(text.trim());
}

function isNumericColumn(body: string[][], column: number): boolean {
  return mostlyNumeric(body, column, NUMERIC_COLUMN_SHARE);
}

function mostlyNumeric(body: string[][], column: number, share: number): boolean {
  const filled = body.map((row) => row[column]).filter((cell) => cell !== "");
  return filled.length > 0 && filled.filter(isNumeric).length >= filled.length * share;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}
