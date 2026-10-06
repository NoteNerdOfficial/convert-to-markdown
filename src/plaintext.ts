import { escapeInline } from "./markdown";
import { splitLines } from "./text";

/**
 * Plain text → Markdown that renders exactly as the text reads.
 *
 * Shared by `.txt` files and text email bodies. Plain text has almost no
 * structure, and the little it has is the structure people type by hand:
 * `>` quoting, and `-` / `*` / `1.` list items. Both of those already mean the
 * same thing in Markdown, so they are kept as Markdown. Everything else stays
 * exactly as typed, since guessing that a line of dashes was meant as a rule,
 * or that an indented block was meant as code, is how a converter invents
 * structure the author didn't write.
 *
 * "As typed" is most of the work. Markdown reads meaning into things plain
 * text uses innocently: a line starting `#` becomes a heading, a row of `===`
 * under a line turns that line into one, and four spaces of indentation turn a
 * paragraph into a code block. Each of those is neutralised so the note shows
 * what the file showed.
 *
 * Lines stay lines. Plain text is usually hard-wrapped, so a single newline is
 * a real line break here rather than a paragraph continuation — which is also
 * how Obsidian renders one.
 */
export function renderPlainText(text: string): string[] {
  const out: string[] = [];
  // Inside a list, indentation is Markdown's own — it nests a sub-item or
  // continues a wrapped one — so it is left as spaces rather than pinned.
  let inList = false;

  for (const raw of splitLines(text)) {
    const line = raw.replace(/[ \t]+$/, "");

    if (line === "") {
      inList = false;
      out.push("");
      continue;
    }

    // A quoted line is a blockquote already.
    if (/^[ \t]*>/.test(line)) {
      inList = false;
      out.push(line);
      continue;
    }

    const [, indent, body] = /^([ \t]*)(.*)$/.exec(line) as RegExpExecArray;

    // `---`, `***`, `===`, `- - -`: a rule, or a setext underline that would
    // promote the line above it to a heading. Checked ahead of list items,
    // since `- - -` is both shapes and Markdown reads it as the rule.
    if (/^[-=_*+](?:[ \t]*[-=_*+])*$/.test(body)) {
      inList = false;
      out.push(`${pinIndent(indent)}\\${body[0]}${escapeInline(body.slice(1))}`);
      continue;
    }

    const item = /^([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(body);
    if (item) {
      inList = true;
      out.push(`${indent}${item[1]}${item[2]}${escapeInline(item[3])}`);
      continue;
    }

    if (inList && indent !== "") {
      out.push(`${indent}${escapeBlockStart(body)}`);
      continue;
    }

    inList = false;
    out.push(`${pinIndent(indent)}${escapeBlockStart(body)}`);
  }

  return [out.join("\n").trim()];
}

/** Escapes inline markup, plus the line-start characters that open a block. */
function escapeBlockStart(body: string): string {
  const escaped = escapeInline(body);
  // `#` opens a heading and `~~~` a code fence; backtick fences and HTML are
  // already covered by the inline escapes.
  if (/^#/.test(escaped)) return `\\${escaped}`;
  if (/^~~~/.test(escaped)) return `\\${escaped}`;
  // A bare `1.` or `-` is an empty list item. (`-` alone is caught earlier.)
  const bareNumber = /^(\d{1,9})([.)])$/.exec(escaped);
  if (bareNumber) return `${bareNumber[1]}\\${bareNumber[2]}`;
  return escaped;
}

/**
 * Leading whitespace as non-breaking spaces.
 *
 * Markdown either strips indentation or, past three spaces, makes a code block
 * of it; a non-breaking space counts as neither, so the text keeps the indent
 * it was typed with. A tab is taken as four.
 */
function pinIndent(indent: string): string {
  return indent.replace(/\t/g, "    ").replace(/ /g, " ");
}
