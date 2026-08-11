import { escapeInline, joinBlocks, squashSpaces, yamlValue } from "../markdown";
import { decodeEntities, decodeText, splitLines } from "../text";
import { ExtractResult } from "./types";

/**
 * .vtt / .srt → Markdown as a transcript rather than as a subtitle file.
 *
 * A caption file's structure is timing, not prose: it is cut into two-second
 * cues sized for the bottom of a screen, and every cue is hard-wrapped to the
 * display width. Writing that out cue by cue produces eight hundred numbered
 * stanzas that nobody can read — the timings are the least interesting thing
 * in the file, and they end up being the only thing the layout expresses.
 *
 * So the cues are put back together: lines rejoined, consecutive cues from the
 * same speaker merged into paragraphs, and a timestamp kept at the head of
 * each paragraph as an anchor back into the recording. What survives is the
 * structure that actually carries meaning — who spoke, in what order, and
 * roughly when — instead of the structure the player needed.
 */
export async function extractSubtitles(data: Buffer): Promise<ExtractResult> {
  const track = parseTrack(decodeText(data));

  if (track.cueCount === 0 && track.malformed.length === 0) {
    throw new Error("no subtitle cues found — the file has no `-->` timing lines");
  }

  const paragraphs = groupIntoParagraphs(track.turns);
  const duration = track.turns.reduce((longest, turn) => Math.max(longest, turn.end), 0);
  const withHours = duration >= 3600;

  const lines: string[] = [];
  if (track.title) lines.push(`# ${escapeInline(track.title)}`, "");

  for (const paragraph of paragraphs) {
    const at = timestamp(paragraph.start, withHours);
    // Chapter tracks are a list of titles with times, not speech: each cue is
    // a whole section of the recording, so each becomes a heading.
    if (track.isChapters) {
      lines.push("", `## ${at} ${paragraph.text}`, "");
      continue;
    }
    const label = paragraph.speaker ? `**${at} ${escapeInline(paragraph.speaker)}:**` : `**${at}**`;
    lines.push(`${label} ${paragraph.text}`, "");
  }

  const speakers = [...new Set(track.turns.map((turn) => turn.speaker).filter((name): name is string => !!name))];

  const frontmatter: Record<string, string> = {
    cues_converted: `${track.cueCount - track.malformed.length}/${track.cueCount}`,
  };
  if (duration > 0) frontmatter.duration = timestamp(duration, true);
  if (track.language) frontmatter.language = yamlValue(track.language);
  if (speakers.length > 0) frontmatter.speakers = yamlValue(speakers.join(", "));

  return { markdown: joinBlocks(lines), warnings: describeGaps(track), frontmatter };
}

/**
 * How long a silence ends a paragraph. Short enough that a genuine pause in
 * speech starts a new one, long enough that the ordinary beat between two
 * cues of continuous speech doesn't.
 */
const PARAGRAPH_GAP_SECONDS = 2.5;

/**
 * Where an uninterrupted monologue gets broken up anyway — at the first
 * sentence end past this many characters, so a forty-minute lecture with one
 * speaker doesn't come out as a single unreadable block.
 */
const SOFT_PARAGRAPH_LIMIT = 700;

interface Turn {
  start: number;
  end: number;
  speaker: string | null;
  /**
   * Set when the file marked a speaker change explicitly — a `>>` or a
   * dialogue dash. Two unnamed speakers trading lines inside one cue are
   * indistinguishable by speaker and by timing, so without this the two halves
   * of an exchange would be merged back into one paragraph.
   */
  forced: boolean;
  /** Already-rendered inline Markdown. */
  text: string;
}

interface Paragraph {
  start: number;
  speaker: string | null;
  text: string;
}

interface Track {
  title: string | null;
  language: string | null;
  isChapters: boolean;
  turns: Turn[];
  cueCount: number;
  /** Timing lines that couldn't be read, quoted so they can be found. */
  malformed: string[];
  /** WebVTT `NOTE` comments — authoring notes, not transcript. */
  notes: string[];
  styleBlocks: number;
  regionBlocks: number;
}

function groupIntoParagraphs(turns: Turn[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | null = null;
  let previousEnd = 0;

  for (const turn of turns) {
    const gap = turn.start - previousEnd;
    const startNew =
      current === null ||
      turn.forced ||
      current.speaker !== turn.speaker ||
      gap > PARAGRAPH_GAP_SECONDS ||
      (current.text.length >= SOFT_PARAGRAPH_LIMIT && endsSentence(current.text));

    if (startNew) {
      current = { start: turn.start, speaker: turn.speaker, text: turn.text };
      paragraphs.push(current);
    } else {
      (current as Paragraph).text = appendCueText((current as Paragraph).text, turn.text);
    }
    previousEnd = Math.max(previousEnd, turn.end);
  }

  return paragraphs;
}

function endsSentence(text: string): boolean {
  return /[.!?…][)"'”’\]]*$/.test(text);
}

/**
 * The shortest repeat long enough to be a real one. Rolling captions repeat
 * whole lines, so the overlap is normally tens of characters; anything below
 * this is two paragraphs that happen to share a few letters.
 */
const MIN_REPEAT = 12;

/**
 * Joins the next cue on, dropping any text it repeats.
 *
 * Auto-generated captions — YouTube's especially — scroll rather than cut:
 * each cue re-states the previous cue's last line and adds one new one, so the
 * same words arrive two or three times. Concatenating naively triples the
 * transcript. Matching the tail of what's been written against the head of
 * what's arriving, at word boundaries on both sides, leaves each phrase once.
 */
function appendCueText(accumulated: string, addition: string): string {
  if (accumulated === "") return addition;
  if (addition === "") return accumulated;
  if (accumulated.endsWith(addition) && atWordBoundary(accumulated, accumulated.length - addition.length)) {
    return accumulated;
  }

  const longest = Math.min(accumulated.length, addition.length);
  for (let length = longest; length >= MIN_REPEAT; length--) {
    if (!accumulated.endsWith(addition.slice(0, length))) continue;
    if (!atWordBoundary(accumulated, accumulated.length - length)) continue;
    const rest = addition.slice(length);
    if (rest !== "" && !/^\s/.test(rest)) continue;
    return rest === "" ? accumulated : `${accumulated}${rest}`;
  }

  return `${accumulated} ${addition}`;
}

function atWordBoundary(text: string, index: number): boolean {
  return index === 0 || /\s/.test(text[index - 1]);
}

function timestamp(seconds: number, withHours: boolean): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return withHours || hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

function describeGaps(track: Track): string[] {
  const warnings: string[] = [];

  if (track.malformed.length > 0) {
    warnings.push(
      `${track.malformed.length} cue${track.malformed.length === 1 ? "" : "s"} had an unreadable timing line and ` +
        `${track.malformed.length === 1 ? "was" : "were"} skipped: ${track.malformed
          .slice(0, 8)
          .map((line) => `\`${line}\``)
          .join(", ")}${track.malformed.length > 8 ? ", …" : ""}`
    );
  }
  for (const note of track.notes) {
    warnings.push(`Comment in the source file, not part of the transcript: ${note}`);
  }
  if (track.styleBlocks > 0 || track.regionBlocks > 0) {
    const blocks = [
      track.styleBlocks > 0 ? `${track.styleBlocks} STYLE` : null,
      track.regionBlocks > 0 ? `${track.regionBlocks} REGION` : null,
    ].filter(Boolean);
    warnings.push(
      `${blocks.join(" and ")} block${track.styleBlocks + track.regionBlocks === 1 ? "" : "s"} dropped — ` +
        "they position and colour the captions on screen and carry no text."
    );
  }

  return warnings;
}

/**
 * Reads WebVTT and SubRip with one parser.
 *
 * The two formats differ in three details — a `WEBVTT` signature line, a comma
 * rather than a dot before the milliseconds, and WebVTT's extra `NOTE`,
 * `STYLE` and `REGION` blocks — and agree on everything that matters: blocks
 * separated by blank lines, each an optional identifier, a `start --> end`
 * line, and the text under it. Accepting both timing punctuations and treating
 * the WebVTT-only blocks as absent when they are makes one reader enough.
 */
/**
 * The bounds a bare "Name:" prefix has to fit to even be considered — long
 * enough for "Dr. Sarah Connor", short enough that an ordinary sentence
 * reaching a colon well into it doesn't qualify.
 */
const BARE_SPEAKER = /^([^:\n]{1,40}):[ \t]+(?=\S)/;

/**
 * Speaker names inferred from a bare "Name: text" prefix — no `<v>`, no `>>`,
 * no quotes, nothing marking the line as a speaker turn except the shape of
 * it. Several transcription tools (Teams, Otter, various Whisper-based ones)
 * write cues this way, and nothing distinguishes "John Doe: Good morning" as
 * a speaker line from "Note: see appendix" as an ordinary sentence except
 * that a transcript's actual speakers keep coming back and a prose aside
 * essentially never repeats itself word for word. So the whole file is
 * scanned first for the shape, and only a name seen more than once is
 * trusted; the assumption is that a two-line transcript is unlikely to exist,
 * and a name that shows up exactly once is far more likely to be a stray
 * "Note:" than a speaker who only ever said one thing.
 */
function recurringBareSpeakers(source: string): Set<string> {
  const counts = new Map<string, number>();

  for (const line of splitLines(source)) {
    const match = BARE_SPEAKER.exec(line.trim());
    if (!match) continue;
    const name = squashSpaces(match[1]);
    if (name === "") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const recurring = new Set<string>();
  for (const [name, count] of counts) {
    if (count >= 2) recurring.add(name);
  }
  return recurring;
}

function parseTrack(source: string): Track {
  const track: Track = {
    title: null,
    language: null,
    isChapters: false,
    turns: [],
    cueCount: 0,
    malformed: [],
    notes: [],
    styleBlocks: 0,
    regionBlocks: 0,
  };

  const recurringSpeakers = recurringBareSpeakers(source);

  // A cue's text can't contain a blank line, in either format, so blank lines
  // are an unambiguous block separator.
  const blocks = source.split(/\r\n\s*?\r\n|\n[ \t]*\n|\r[ \t]*\r/);

  for (const [index, block] of blocks.entries()) {
    const lines = splitLines(block)
      .map((line) => line.replace(/\s+$/, ""))
      .filter((line, position, all) => !(line.trim() === "" && (position === 0 || position === all.length - 1)));
    if (lines.length === 0) continue;

    if (index === 0 && /^\uFEFF?WEBVTT/.test(lines[0])) {
      readHeader(lines, track);
      continue;
    }
    if (/^NOTE(\s|$)/.test(lines[0])) {
      const text = squashSpaces([lines[0].replace(/^NOTE\s*/, ""), ...lines.slice(1)].join(" "));
      if (text !== "") track.notes.push(text);
      continue;
    }
    if (/^STYLE\s*$/.test(lines[0])) {
      track.styleBlocks++;
      continue;
    }
    if (/^REGION\s*$/.test(lines[0])) {
      track.regionBlocks++;
      continue;
    }

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      // Not a cue and not a known block type. Only worth reporting if it has
      // content — trailing whitespace at the end of a file is not a loss.
      if (lines.some((line) => line.trim() !== "")) track.malformed.push(truncate(lines[0]));
      continue;
    }

    track.cueCount++;
    const timing = parseTiming(lines[timingIndex]);
    if (!timing) {
      track.malformed.push(truncate(lines[timingIndex]));
      continue;
    }

    // Webex writes the speaker on its own line ahead of the timing line —
    // `"Priya Rao" (100000002)` — rather than inside the cue text the way
    // `<v>`, `>>` and a dialogue dash do. It's cue-level, not line-level: one
    // Webex cue is always one speaker, so it applies to everything the cue
    // says, and only fills in where the cue text didn't already name someone
    // some other way.
    const cueSpeaker = webexSpeaker(lines.slice(0, timingIndex));

    for (const turn of readCueText(lines.slice(timingIndex + 1), recurringSpeakers)) {
      track.turns.push({ start: timing.start, end: timing.end, ...turn, speaker: turn.speaker ?? cueSpeaker });
    }
  }

  // Cues are normally in order already, but a merged or hand-edited file need
  // not be, and paragraphing depends on reading them chronologically.
  track.turns.sort((a, b) => a.start - b.start);
  return track;
}

function readHeader(lines: string[], track: Track): void {
  const title = lines[0].replace(/^\uFEFF?WEBVTT\s*/, "").replace(/^-\s*/, "").trim();
  if (title !== "") track.title = title;

  for (const line of lines.slice(1)) {
    const match = /^([A-Za-z-]+)\s*:\s*(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, key, value] = match;
    if (/^language$/i.test(key)) track.language = value.trim();
    if (/^kind$/i.test(key) && /^chapters$/i.test(value.trim())) track.isChapters = true;
  }
}

/**
 * `HH:MM:SS.mmm`, `MM:SS.mmm`, and the SubRip comma spelling of either. The
 * hours field is optional in WebVTT and mandatory in SubRip, and writers are
 * inconsistent enough about both that being permissive costs nothing.
 */
const TIMESTAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;

function parseTiming(line: string): { start: number; end: number } | null {
  const match = /^(\S+)\s*-->\s*(\S+)/.exec(line.trim());
  if (!match) return null;

  const start = parseTimestamp(match[1]);
  const end = parseTimestamp(match[2]);
  if (start === null || end === null) return null;
  // Anything after the two timestamps is cue settings — `line:0`,
  // `position:20%`, SubRip's `X1:…` coordinates. All of it places the caption
  // on the screen, and none of it survives into a document.
  return { start, end: Math.max(end, start) };
}

function parseTimestamp(token: string): number | null {
  const match = TIMESTAMP.exec(token);
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  const milliseconds = fraction ? Number(fraction.padEnd(3, "0")) : 0;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + milliseconds / 1000;
}

interface Span {
  speaker: string | null;
  bold: boolean;
  italic: boolean;
  text: string;
}

/**
 * A cue's text, as one or more speaker turns.
 *
 * Three different conventions mark who is talking, and a real-world file uses
 * whichever its author's tooling produced: WebVTT's `<v Name>` voice span, the
 * broadcast-captioning `>>` (with `>> NAME:` when it's known), and the
 * subtitling convention of prefixing each speaker's line with a dash. All
 * three have to be understood in any case — `>` and `-` at the start of a line
 * are a blockquote and a list item in Markdown, so leaving them in place would
 * corrupt the note even if the speaker information were thrown away.
 */
function readCueText(
  lines: string[],
  recurringSpeakers: Set<string>
): { speaker: string | null; forced: boolean; text: string }[] {
  const spans = tokenizeCue(lines.join("\n"));
  const turns: { speaker: string | null; forced: boolean; runs: Span[] }[] = [];
  let current: { speaker: string | null; forced: boolean; runs: Span[] } | null = null;
  let atLineStart = true;

  for (const span of spans) {
    const pieces = span.text.split("\n");
    for (const [index, piece] of pieces.entries()) {
      const startsLine = index > 0;
      if (startsLine) atLineStart = true;

      let text = piece;
      let speaker = span.speaker;
      let forceBreak = false;

      if (atLineStart) {
        const marker = readTurnMarker(text, recurringSpeakers);
        if (marker) {
          forceBreak = marker.forceBreak;
          text = marker.rest;
          if (marker.speaker) speaker = marker.speaker;
        }
      }
      if (text.trim() !== "") atLineStart = false;
      if (text.trim() === "" && !forceBreak) continue;

      if (current === null || speaker !== current.speaker || (forceBreak && current.runs.length > 0)) {
        current = { speaker, forced: forceBreak, runs: [] };
        turns.push(current);
      }
      // A line break inside a cue was display wrapping, so it becomes a space.
      // A break *between* spans on the same line was never a space to begin
      // with — `<b>name</b>, title` must not become `name , title`.
      const continuesLine = startsLine && current.runs.length > 0;
      current.runs.push({ ...span, speaker, text: continuesLine ? ` ${text}` : text });
    }
  }

  return turns
    .map((turn) => ({ speaker: turn.speaker, forced: turn.forced, text: renderSpans(turn.runs) }))
    .filter((turn) => turn.text !== "");
}

/**
 * Webex's speaker line — `2 "Alex Kim (They/Them)" (100000001)` — from the
 * lines a cue carries ahead of its timing line.
 *
 * The cue number WebVTT's own optional identifier would normally carry sits
 * on this same line, immediately before the quoted name, rather than on a
 * line of its own — so the number is read as an optional prefix rather than
 * assumed away. The quotes are what make the rest unambiguous — nothing else
 * legitimately shows up ahead of a timing line quoted like that, parenthesised
 * name included: Webex appends a participant's pronouns to their display name
 * the same way, so the name itself may well contain parentheses of its own,
 * which is why the trailing `(id)` is matched at the end of the line rather
 * than as the first parenthesised group found.
 */
function webexSpeaker(precedingLines: string[]): string | null {
  for (const line of precedingLines) {
    const match = /^(?:\d+[ \t]+)?"([^"]*)"[ \t]*\(\d+\)[ \t]*$/.exec(line.trim());
    const name = match ? squashSpaces(match[1]) : "";
    if (name !== "") return name;
  }
  return null;
}

function readTurnMarker(
  line: string,
  recurringSpeakers: Set<string>
): { speaker: string | null; rest: string; forceBreak: boolean } | null {
  const chevrons = /^>{2,3}\s*/.exec(line);
  if (chevrons) {
    const rest = line.slice(chevrons[0].length);
    // `>> ROGER BINGHAM: text` names the speaker; a bare `>>` only says it
    // changed. The name is bounded to keep an ordinary sentence containing a
    // colon from being read as one. Either way the cue is forced onto a new
    // paragraph: `>>` alone marks a change of speaker without saying who to,
    // and two of those in a row are otherwise indistinguishable from one
    // speaker's cue that happened to get split in two.
    const named = /^([^:]{1,40}):\s*/.exec(rest);
    return named
      ? { speaker: squashSpaces(named[1]), rest: rest.slice(named[0].length), forceBreak: true }
      : { speaker: null, rest, forceBreak: true };
  }

  const dash = /^[-–—]\s+/.exec(line);
  if (dash) return { speaker: null, rest: line.slice(dash[0].length), forceBreak: true };

  // A bare "Name:" with nothing else marking it as a speaker line — only
  // trusted for a name `recurringBareSpeakers` already confirmed repeats
  // across the file, since nothing about this one line can tell "John Doe:"
  // apart from "Note:". Unlike `>>` and the dash, this always names an actual
  // person rather than leaving the speaker anonymous, so there's no need to
  // force a new paragraph the way those do — two consecutive cues both
  // marked "John Doe:" are already distinguishable from two different
  // speakers by that name alone, and should merge into one paragraph the
  // same as Webex's cue-level speaker does.
  const bare = BARE_SPEAKER.exec(line);
  if (bare) {
    const name = squashSpaces(bare[1]);
    if (recurringSpeakers.has(name)) return { speaker: name, rest: line.slice(bare[0].length), forceBreak: false };
  }

  return null;
}

/**
 * Splits cue text into formatted spans, resolving WebVTT's cue tags.
 *
 * `<i>` and `<b>` are the only ones that carry into Markdown. `<c.yellow>`,
 * `<lang>`, `<ruby>`, `<u>` and SubRip's `<font>` are styling with no Markdown
 * equivalent, and `<00:00:16.500>` is a karaoke timing that highlights words
 * as they're spoken — all of them are dropped, and the text inside them kept.
 */
function tokenizeCue(source: string): Span[] {
  const spans: Span[] = [];
  const voices: string[] = [];
  let bold = 0;
  let italic = 0;
  let cursor = 0;

  const push = (text: string) => {
    if (text === "") return;
    spans.push({
      speaker: voices.length > 0 ? voices[voices.length - 1] : null,
      bold: bold > 0,
      italic: italic > 0,
      // Advanced SubStation override blocks (`{\an8}`, `{\pos(…)}`) ride along
      // in .srt files written by video tools; they are positioning, not text.
      text: decodeEntities(text.replace(/\{\\[^}]*\}/g, "")),
    });
  };

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open === -1) break;
    const close = source.indexOf(">", open);
    if (close === -1) break;

    push(source.slice(cursor, open));
    const tag = source.slice(open + 1, close);
    cursor = close + 1;

    if (/^\d/.test(tag)) continue; // karaoke timestamp

    const closing = tag.startsWith("/");
    const name = (closing ? tag.slice(1) : tag).split(/[\s.]/)[0].toLowerCase();

    if (name === "i" || name === "em") italic = closing ? Math.max(0, italic - 1) : italic + 1;
    else if (name === "b" || name === "strong") bold = closing ? Math.max(0, bold - 1) : bold + 1;
    else if (name === "v") {
      if (closing) voices.pop();
      else {
        // `<v.first.loud Roger Bingham>` — classes on the tag, then the name.
        const speaker = squashSpaces(tag.replace(/^v[^\s]*\s*/i, ""));
        voices.push(speaker === "" ? "Unknown" : speaker);
      }
    }
  }

  push(source.slice(cursor));
  return spans;
}

function renderSpans(spans: Span[]): string {
  let out = "";

  for (let index = 0; index < spans.length; ) {
    const { bold, italic } = spans[index];
    // Adjacent spans with the same formatting are one run: emitting them
    // separately would produce `**one** **run**` where `**one run**` was meant.
    let text = "";
    while (index < spans.length && spans[index].bold === bold && spans[index].italic === italic) {
      text += spans[index++].text;
    }

    const escaped = escapeInline(text);
    if (!bold && !italic) {
      out += escaped;
      continue;
    }

    // Emphasis markers can't have whitespace inside them — `** bold **` isn't
    // bold in any Markdown flavour — so the padding stays outside.
    const [, leading, core, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(escaped) as RegExpExecArray;
    if (core === "") {
      out += escaped;
      continue;
    }
    let wrapped = core;
    if (italic) wrapped = `*${wrapped}*`;
    if (bold) wrapped = `**${wrapped}**`;
    out += `${leading}${wrapped}${trailing}`;
  }

  return squashSpaces(out);
}

function truncate(line: string): string {
  const text = squashSpaces(line);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
