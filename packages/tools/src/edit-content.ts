import type { RepoPath, ToolError } from "@coding-agent/agent-core";
import type { EditInput } from "./edit-input.ts";
import {
  type EditTextView,
  foldLine,
  normalizeLineEndings,
  projectText,
  splitLines,
} from "./edit-text.ts";
import { quote } from "./messages.ts";
import { boundToolOutput } from "./output-budget.ts";

type EditResult =
  | { readonly ok: true; readonly content: string; readonly changed: number }
  | { readonly ok: false; readonly error: ToolError };

interface Replacement {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const BOM = "\uFEFF";

export function applyEdits(decoded: string, path: RepoPath, edits: EditInput["edits"]): EditResult {
  const file = quote(path);
  const bom = decoded.startsWith(BOM) ? BOM : "";
  const current = decoded.slice(bom.length);
  const lines = splitLines(current);
  const exact = projectText(current, lines);
  let fuzzy: EditTextView | undefined;
  const replacements: Replacement[] = [];
  for (const [index, { oldText, newText }] of edits.entries()) {
    let target = normalizeLineEndings(oldText);
    let view = exact;
    let match = findMatches(view.text, target);
    if (match.count === 0) {
      target = target.split("\n").map(foldLine).join("\n");
      if (target !== "") {
        fuzzy ??= projectText(current, lines, true);
        view = fuzzy;
        match = findMatches(view.text, target);
      }
    }
    if (match.count === 0) {
      return {
        ok: false,
        error: {
          code: "NO_MATCH",
          message: `edits[${index}].oldText does not occur in ${file}. Read the file and copy the text to replace.`,
        },
      };
    }
    if (match.count > 1) {
      return {
        ok: false,
        error: {
          code: "AMBIGUOUS_MATCH",
          message: `edits[${index}].oldText occurs ${match.count} times in ${file}. Add surrounding text to make it unique.`,
        },
      };
    }
    const { start, replacementEnding } = view.locateSource(match.first);
    const { end } = view.locateSource(match.first + target.length - 1);
    const overlap = replacements.find((other) => start < other.end && other.start < end);
    if (overlap !== undefined) {
      return {
        ok: false,
        error: {
          code: "OVERLAPPING_EDITS",
          message: `edits[${overlap.index}] and edits[${index}] overlap in ${file}. Merge them or target disjoint ranges.`,
        },
      };
    }
    replacements.push({
      index,
      start,
      end,
      text: normalizeLineEndings(newText).replaceAll("\n", replacementEnding),
    });
  }

  replacements.sort((left, right) => left.start - right.start);
  const chunks: string[] = [];
  // Empty replacements bring later pieces together. Keep every changed edit at that boundary.
  let boundaryEdits: number[] = [];
  const spliceError = (problem: string): ToolError => {
    const edits = boundaryEdits.map((index) => `edits[${index}]`).join(", ");
    return {
      code: "SCHEMA_VIOLATION",
      message: boundToolOutput(`${edits} would ${problem}`).content,
    };
  };
  const append = (text: string, index?: number): ToolError | undefined => {
    if (index !== undefined) boundaryEdits.push(index);
    if (text === "") return undefined;
    if (chunks.length === 0 && bom === "" && text.startsWith(BOM)) {
      return spliceError(
        `introduce a leading BOM in ${file}. Remove U+FEFF from the replacement or keep it inside the file.`,
      );
    }
    if (chunks.at(-1)?.endsWith("\r") && text.startsWith("\n")) {
      return spliceError(
        `merge line breaks in ${file}. Include both line breaks in the target and supply the intended line endings together.`,
      );
    }
    chunks.push(text);
    boundaryEdits = index === undefined ? [] : [index];
    return undefined;
  };
  let cursor = 0;
  let changed = 0;
  for (const { start, end, text, index } of replacements) {
    const rangeChanged = current.slice(start, end) !== text;
    const failure =
      append(current.slice(cursor, start)) ?? append(text, rangeChanged ? index : undefined);
    if (failure !== undefined) return { ok: false, error: failure };
    if (rangeChanged) changed += 1;
    cursor = end;
  }
  const tailError = append(current.slice(cursor));
  if (tailError !== undefined) return { ok: false, error: tailError };
  const content = chunks.join("");
  if (content === current) {
    return {
      ok: false,
      error: {
        code: "NO_CHANGE",
        message: `The edits leave ${file} unchanged. Supply a replacement that changes the file.`,
      },
    };
  }
  return { ok: true, content: bom + content, changed };
}

function findMatches(content: string, target: string): { count: number; first: number } {
  if (target === "") return { count: 0, first: -1 };
  let count = 0;
  let first = -1;
  // Advance by one code unit to count overlapping starts, such as both placements of "aa" in "aaa".
  for (let at = content.indexOf(target); at !== -1; at = content.indexOf(target, at + 1)) {
    if (count === 0) first = at;
    count += 1;
  }
  return { count, first };
}
