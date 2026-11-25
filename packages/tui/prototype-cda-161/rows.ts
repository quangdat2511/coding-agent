import wrapAnsi from "wrap-ansi";
import type { Fixture } from "./fixtures.ts";

export type Layout = "compact" | "dual";
export type Tone = "context" | "added" | "removed" | "fold";
export interface Row {
  readonly gutter: string;
  readonly marker: string;
  readonly text: string;
  readonly tone: Tone;
}

const CONTEXT_LINES = 3;

export function diffRows(fixture: Fixture, layout: Layout, columns: number) {
  const { lines, edits, added, removed } = fixture;
  const digits = Math.max(3, String(Math.max(lines.length, lines.length + added - removed)).length);
  const gutterWidth = layout === "compact" ? digits : digits * 2 + 1;
  const rows: Row[] = [];
  const number = (line: number | undefined) => (line?.toString() ?? "").padStart(digits);

  let oldLine = 1;
  let newLine = 1;
  function append(tone: Tone, text: string, oldNumber?: number, newNumber?: number) {
    const gutter =
      layout === "compact"
        ? number(newNumber ?? oldNumber)
        : `${number(oldNumber)} ${number(newNumber)}`;
    const marker = { added: "+", removed: "-", context: " ", fold: "…" }[tone];
    const wrapped = wrapAnsi(text.replaceAll("\t", "    "), columns - gutterWidth - 5, {
      trim: false,
      hard: true,
      wordWrap: tone === "fold",
    }).split("\n");
    for (const [index, part] of wrapped.entries()) {
      rows.push({
        gutter: index === 0 ? gutter : " ".repeat(gutterWidth),
        marker: index === 0 ? marker : "↪",
        text: part,
        tone,
      });
    }
  }

  function context(until: number, keepStart: number, keepEnd: number) {
    const count = until - oldLine;
    const visibleAtStart = Math.min(keepStart, count);
    const hidden = Math.max(0, count - visibleAtStart - keepEnd);
    for (const line of lines.slice(oldLine - 1, oldLine - 1 + visibleAtStart)) {
      append("context", line, oldLine++, newLine++);
    }
    if (hidden > 0) {
      append("fold", `${hidden} unchanged ${hidden === 1 ? "line" : "lines"}`);
      oldLine += hidden;
      newLine += hidden;
    }
    for (const line of lines.slice(oldLine - 1, until - 1)) {
      append("context", line, oldLine++, newLine++);
    }
  }

  for (const [index, edit] of edits.entries()) {
    context(edit.line, index === 0 ? 0 : CONTEXT_LINES, CONTEXT_LINES);
    for (const line of lines.slice(oldLine - 1, oldLine - 1 + edit.remove)) {
      append("removed", line, oldLine++);
    }
    for (const line of edit.insert) {
      append("added", line, undefined, newLine++);
    }
  }
  context(lines.length + 1, CONTEXT_LINES, 0);

  const heading =
    layout === "compact"
      ? "#".padStart(digits)
      : `${"old".padStart(digits)} ${"new".padStart(digits)}`;
  return { heading, rows };
}
