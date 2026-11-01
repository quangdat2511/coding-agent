import stringWidth from "string-width";

// One row of editable text with a cursor: the Prompt and the reason for a denial. The cursor and
// the start of the part in view are UTF-16 indexes that always fall between two characters as the
// person sees them (grapheme clusters), so no key splits a letter from its combining marks or an
// emoji in two. Ink measures text with string-width, and so does this module, so a row it lays out
// is exactly as wide as Ink draws it.
export interface Editor {
  readonly text: string;
  readonly cursor: number;
  // Where the part of the text in view starts. It moves only as far as it must to keep the cursor
  // in view, so the text does not jump while the cursor moves inside the row.
  readonly start: number;
}

export const EMPTY_EDITOR: Editor = { text: "", cursor: 0, start: 0 };

export type EditAction =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "delete" }
  | { readonly kind: "move"; readonly to: "left" | "right" | "home" | "end" };

// The text in view around the cursor. `at` is the character under the cursor, or a space when the
// cursor is after the last character, so the cursor always has a cell to show in.
export interface EditorView {
  readonly before: string;
  readonly at: string;
  readonly after: string;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// `columns` is the width of the row the text is shown in.
export function edit(editor: Editor, action: EditAction, columns: number): Editor {
  const { text, cursor } = editor;
  let next: Pick<Editor, "text" | "cursor">;
  switch (action.kind) {
    case "insert":
      next = {
        text: text.slice(0, cursor) + action.text + text.slice(cursor),
        cursor: cursor + action.text.length,
      };
      break;
    case "backspace": {
      const before = previousBoundary(text, cursor);
      next = { text: text.slice(0, before) + text.slice(cursor), cursor: before };
      break;
    }
    case "delete":
      next = { text: text.slice(0, cursor) + text.slice(nextBoundary(text, cursor)), cursor };
      break;
    case "move":
      next = { text, cursor: moved(text, cursor, action.to) };
      break;
    default: {
      const unhandled: never = action;
      throw new Error(`Unhandled edit action: ${JSON.stringify(unhandled)}`);
    }
  }
  return { ...next, start: startInView(next.text, next.cursor, editor.start, columns) };
}

export function editorView(editor: Editor, columns: number): EditorView {
  const { text, cursor } = editor;
  // The row may have changed width since the last edit, as when the terminal is resized.
  const start = startInView(text, cursor, editor.start, columns);
  const atEnd = nextBoundary(text, cursor);
  const at = text.slice(cursor, atEnd) || " ";
  const before = text.slice(start, cursor);
  let used = stringWidth(before) + stringWidth(at);
  let after = "";
  for (const { segment } of graphemes.segment(text.slice(atEnd))) {
    used += stringWidth(segment);
    if (used > Math.max(1, columns)) {
      break;
    }
    after += segment;
  }
  return { before, at, after };
}

function moved(text: string, cursor: number, to: "left" | "right" | "home" | "end"): number {
  switch (to) {
    case "left":
      return previousBoundary(text, cursor);
    case "right":
      return nextBoundary(text, cursor);
    case "home":
      return 0;
    case "end":
      return text.length;
  }
}

// Keeps the cursor and the cell it takes in view, moving `start` as little as possible. Once the
// rest of the text from an earlier character fits in the row, as after deleting from the end, the
// row shows it again rather than leaving the start of the row empty.
function startInView(text: string, cursor: number, previous: number, columns: number): number {
  const width = Math.max(1, columns);
  const cursorCell = stringWidth(text.slice(cursor, nextBoundary(text, cursor))) || 1;
  let start = Math.min(previous, cursor);
  while (start < cursor && stringWidth(text.slice(start, cursor)) + cursorCell > width) {
    start = nextBoundary(text, start);
  }
  while (start > 0) {
    const earlier = previousBoundary(text, start);
    // The cell after the last character counts, because the cursor may move there.
    if (stringWidth(text.slice(earlier)) + 1 > width) {
      break;
    }
    start = earlier;
  }
  return start;
}

function previousBoundary(text: string, index: number): number {
  let boundary = 0;
  for (const { index: segmentStart } of graphemes.segment(text)) {
    if (segmentStart >= index) {
      break;
    }
    boundary = segmentStart;
  }
  return boundary;
}

function nextBoundary(text: string, index: number): number {
  for (const { index: segmentStart, segment } of graphemes.segment(text)) {
    if (segmentStart >= index) {
      return segmentStart + segment.length;
    }
  }
  return text.length;
}
