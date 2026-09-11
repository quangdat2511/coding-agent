import type { CheckStatus, ToolCallStatus } from "@/session/events";

export const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  invert: "\x1b[7m",
} as const;

export function paint(code: string, text: string): string {
  return `${code}${text}${A.reset}`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ANSI_PREFIX = /^\x1b\[[0-9;]*m/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function ansiPrefix(text: string): string | null {
  return text.match(ANSI_PREFIX)?.[0] ?? null;
}

export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

export function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let out = "";
  let seen = 0;
  let index = 0;
  while (index < text.length && seen < width - 1) {
    const sequence = ansiPrefix(text.slice(index));
    if (sequence) {
      out += sequence;
      index += sequence.length;
      continue;
    }
    out += text[index];
    index += 1;
    seen += 1;
  }
  return `${out}${A.reset}…`;
}

export function pad(text: string, width: number): string {
  const truncated = truncate(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of paragraph.split(" ")) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

export function toolGlyph(status: ToolCallStatus): string {
  switch (status) {
    case "ok":
      return paint(A.green, "✓");
    case "error":
      return paint(A.red, "✗");
    case "rejected":
      return paint(A.red, "⊘");
    case "cancelled":
      return paint(A.yellow, "⊗");
    case "awaiting-approval":
      return paint(A.yellow, "⏸");
    default:
      return paint(A.cyan, "●");
  }
}

export function checkGlyph(status: CheckStatus): string {
  switch (status) {
    case "pass":
      return paint(A.green, "✓");
    case "fail":
      return paint(A.red, "✗");
    case "running":
      return paint(A.cyan, "●");
    default:
      return paint(A.gray, "○");
  }
}

export function riskColor(risk: string): string {
  if (risk === "execute") return A.red;
  if (risk === "write") return A.yellow;
  return A.gray;
}
