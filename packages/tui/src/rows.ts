import wrapAnsi from "wrap-ansi";
import type { TranscriptEntry } from "./types.ts";

// One terminal row of the laid-out transcript. offset counts the rows of its entry from 0, so an
// entry ID and an offset name the same text at any terminal width.
export interface TranscriptRow {
  readonly entryId: string;
  readonly offset: number;
  readonly text: string;
}

type Entry<Kind extends TranscriptEntry["kind"]> = Extract<TranscriptEntry, { kind: Kind }>;

const TAB = "    ";
const ESC = "\u001b";
const USER_PREFIX = "> ";
const INDENT = "  ";

// TuiModel entries are readonly, so an entry object keeps its rows until the width changes and an
// update only wraps the entries it replaced.
const cache = new WeakMap<TranscriptEntry, { columns: number; lines: readonly string[] }>();

// Lays out the whole transcript at the given width. Consecutive entries are separated by one blank
// row, which belongs to the entry above it.
export function transcriptRows(
  transcript: readonly TranscriptEntry[],
  columns: number,
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const [index, entry] of transcript.entries()) {
    const lines = entryLines(entry, columns);
    const block = index === transcript.length - 1 ? lines : [...lines, ""];
    for (const [offset, text] of block.entries()) {
      rows.push({ entryId: entry.id, offset, text });
    }
  }
  return rows;
}

function entryLines(entry: TranscriptEntry, columns: number): readonly string[] {
  const cached = cache.get(entry);
  if (cached?.columns === columns) {
    return cached.lines;
  }
  const lines = layoutEntry(entry, columns);
  cache.set(entry, { columns, lines });
  return lines;
}

function layoutEntry(entry: TranscriptEntry, columns: number): string[] {
  switch (entry.kind) {
    case "user":
      return userLines(entry, columns);
    case "assistant":
      return [...wrap(`assistant [${entry.status}]`, columns), ...wrap(entry.text, columns)];
    case "tool_call":
      return toolCallLines(entry, columns);
    default: {
      const unhandled: never = entry;
      throw new Error(`Unhandled transcript entry: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Wrapped lines continue under the text rather than under the prompt marker.
function userLines(entry: Entry<"user">, columns: number): string[] {
  const lines = wrap(entry.text, columns - USER_PREFIX.length);
  return (lines.length === 0 ? [""] : lines).map(
    (line, index) => (index === 0 ? USER_PREFIX : INDENT) + line,
  );
}

function toolCallLines(entry: Entry<"tool_call">, columns: number): string[] {
  const { result } = entry;
  // Status, error code and truncation are spelled out because colors depend on the terminal.
  const details = [entry.status, result?.errorCode, result?.truncated ? "truncated" : undefined]
    .filter(Boolean)
    .join(", ");
  const header = [entry.toolName, entry.summary, `[${details}]`].filter(Boolean).join(" ");
  const output =
    result === undefined
      ? []
      : wrap(result.content, columns - INDENT.length).map((line) => INDENT + line);
  return [...wrap(header, columns), ...output];
}

// Wraps text the way Ink wraps a <Text> (ink/build/wrap-text.js), so a row never needs wrapping
// again. Empty text takes no rows, as an empty <Text> takes no height.
function wrap(text: string, columns: number): string[] {
  const display = toDisplayText(text);
  if (display === "") {
    return [];
  }
  return wrapAnsi(display, Math.max(1, columns), { trim: false, hard: true }).split("\n");
}

// Ink strips escape sequences other than colors and links but writes other control characters as
// they are. A tab or carriage return would then move the cursor away from where Ink's layout put
// it and break the in-place redraw, so they are replaced before Ink sees the text.
function toDisplayText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, TAB)
    .replace(/\p{Cc}/gu, (char) => (char === "\n" || char === ESC || char >= "\u0080" ? char : ""));
}
