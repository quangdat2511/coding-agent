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
const INDENT = "  ";
// How many rows of Tool Progress an executing call shows.
export const PROGRESS_ROWS = 5;

// The marker in front of a Coding Task: on a submitted task's first row here, and in the Prompt
// while a task is typed, so a task keeps its look once it is submitted. The task's other rows start
// under its text rather than under the marker.
export const TASK_MARKER = "> ";
export const TASK_CONTINUATION = " ".repeat(TASK_MARKER.length);

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
      return assistantLines(entry, columns);
    case "tool_call":
      return toolCallLines(entry, columns);
    case "verification":
      return [
        ...wrap(`verification [${entry.status}]`, columns),
        ...(entry.evidence ?? []).flatMap((line) => indented(line, columns)),
      ];
    case "notice":
      return wrap(entry.text, columns);
    case "outcome":
      return outcomeLines(entry, columns);
    default: {
      const unhandled: never = entry;
      throw new Error(`Unhandled transcript entry: ${JSON.stringify(unhandled)}`);
    }
  }
}

function userLines(entry: Entry<"user">, columns: number): string[] {
  const lines = wrap(entry.text, columns - TASK_MARKER.length);
  return (lines.length === 0 ? [""] : lines).map(
    (line, index) => (index === 0 ? TASK_MARKER : TASK_CONTINUATION) + line,
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
      ? progressLines(entry.progress, columns)
      : indented(result.content, columns);
  return [...wrap(header, columns), ...output];
}

// Reasoning comes before the text, indented under the header, so it reads as the model thinking
// rather than as its answer.
function assistantLines(entry: Entry<"assistant">, columns: number): string[] {
  return [
    ...wrap(`assistant [${entry.status}]`, columns),
    ...indented(entry.reasoning ?? "", columns),
    ...wrap(entry.text, columns),
  ];
}

// The last rows of an executing call's output, so a long command does not look stalled while the
// call keeps a fixed height. The Tool Result replaces them when the call completes.
function progressLines(progress: string | undefined, columns: number): string[] {
  if (progress === undefined) {
    return [];
  }
  return indented(progress.replace(/\n+$/, ""), columns).slice(-PROGRESS_ROWS);
}

function outcomeLines(entry: Entry<"outcome">, columns: number): string[] {
  const { failure } = entry;
  const header = `session [${[entry.status, failure?.code].filter(Boolean).join(", ")}]`;
  const workspace = [
    entry.workspaceChanged ? "workspace changed" : "workspace unchanged",
    entry.partialChangesPossible ? "partial changes possible" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  return [
    ...wrap(header, columns),
    ...indented(failure?.message ?? "", columns),
    ...indented(workspace, columns),
  ];
}

function indented(text: string, columns: number): string[] {
  return wrap(text, columns - INDENT.length).map((line) => INDENT + line);
}

// Wraps text the way Ink wraps a <Text> (ink/build/wrap-text.js), so a row never needs wrapping
// again. Empty text takes no rows, as an empty <Text> takes no height.
export function wrap(text: string, columns: number): string[] {
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
