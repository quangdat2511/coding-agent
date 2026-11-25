import wrapAnsi from "wrap-ansi";
import type { DiffLine } from "./fixtures.ts";

type Tone = "context" | "added" | "removed" | "meta";
interface Span {
  readonly text: string;
  readonly tone: Tone;
}

interface Row {
  readonly spans: readonly [gutter: Span, body: Span];
}

const TAB = "    ";
const MARKER = { added: "+", removed: "-", context: " " } as const;

export function diffRows(lines: readonly DiffLine[], columns: number): Row[] {
  const digits = lines.reduce(
    (width, line) =>
      "lineNumber" in line ? Math.max(width, String(line.lineNumber).length) : width,
    1,
  );
  const blankGutter = " ".repeat(digits + 3);
  const rows: Row[] = [];

  for (const line of lines) {
    if (!("lineNumber" in line)) {
      rows.push({
        spans: [
          { text: blankGutter, tone: "meta" },
          { text: line.kind === "gap" ? "…" : "Diff truncated", tone: "meta" },
        ],
      });
      continue;
    }

    const gutter = `  ${String(line.lineNumber).padStart(digits)} `;
    const wrapped = wrapAnsi(line.text.replaceAll("\t", TAB), columns - blankGutter.length - 2, {
      trim: false,
      hard: true,
      wordWrap: false,
    }).split("\n");
    for (const [index, text] of wrapped.entries()) {
      const marker = index === 0 ? MARKER[line.kind] : "↪";
      rows.push({
        spans: [
          { text: index === 0 ? gutter : blankGutter, tone: "meta" },
          { text: `${marker} ${text}`, tone: line.kind },
        ],
      });
    }
  }
  return rows;
}
