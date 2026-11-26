const LINE_BREAK = /\r\n?|\n/g;

export function normalizeLineEndings(text: string): string {
  return text.replace(LINE_BREAK, "\n");
}

export function foldLine(line: string): string {
  // trimEnd also treats U+FEFF as whitespace. Keep it after the leading BOM has been removed.
  const end = Math.max(line.trimEnd().length, line.lastIndexOf("\uFEFF") + 1);
  return line
    .slice(0, end)
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface Line {
  readonly start: number;
  readonly end: number;
  readonly ending: string;
  readonly replacementEnding: string;
}

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let previousEnding = "\n";
  for (const { 0: ending, index: end } of text.matchAll(LINE_BREAK)) {
    lines.push({ start, end, ending, replacementEnding: ending });
    start = end + ending.length;
    previousEnding = ending;
  }
  lines.push({ start, end: text.length, ending: "", replacementEnding: previousEnding });
  return lines;
}

interface ProjectedLine {
  readonly line: Line;
  readonly offset: number;
  readonly length: number;
}

export interface EditTextView {
  readonly text: string;
  locateSource(offset: number): { start: number; end: number; replacementEnding: string };
}

export function projectText(text: string, lines: readonly Line[], fuzzy = false): EditTextView {
  const projected: ProjectedLine[] = [];
  const chunks: string[] = [];
  let offset = 0;
  for (const line of lines) {
    const original = text.slice(line.start, line.end);
    const body = fuzzy ? foldLine(original) : original;
    projected.push({ line, offset, length: body.length });
    const ending = line.ending === "" ? "" : "\n";
    chunks.push(body, ending);
    offset += body.length + ending.length;
  }
  return {
    text: chunks.join(""),
    locateSource(offset) {
      const { line, offset: lineOffset, length } = lineAt(projected, offset);
      const column = offset - lineOffset;
      if (column === length) {
        // A projected newline spans the full original ending.
        return {
          start: line.end,
          end: line.end + line.ending.length,
          replacementEnding: line.replacementEnding,
        };
      }
      const start = line.start + column;
      return { start, end: start + 1, replacementEnding: line.replacementEnding };
    },
  };
}

function lineAt(lines: readonly ProjectedLine[], offset: number): ProjectedLine {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = lines[mid];
    if (candidate !== undefined && candidate.offset <= offset) low = mid + 1;
    else high = mid;
  }
  const line = lines[low - 1];
  if (line === undefined) throw new RangeError("The edit match is outside the projected text.");
  return line;
}
