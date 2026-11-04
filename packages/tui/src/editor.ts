import stringWidth from "string-width";

// Editable text with a cursor: the Prompt and the reason for a denial. The cursor and the start of
// the part in view are UTF-16 indexes that always fall between two characters as the person sees
// them (grapheme clusters), so no key splits a letter from its combining marks or an emoji in two.
// Ink measures text with string-width, and so does this module, so a row it lays out is exactly as
// wide as Ink draws it.
export interface Editor {
  readonly text: string;
  readonly cursor: number;
  // Where the part of the text in view starts: its first character in one row, or the first
  // character of the top row in view of wrapped rows. It moves only as far as it must to keep the
  // cursor in view, so the text does not jump while the cursor moves inside what is shown.
  readonly start: number;
  // The column Up and Down aim for. It is kept while they repeat, so a short line on the way does
  // not pull the cursor to the left for good, and any other key forgets it.
  readonly goal?: number;
}

export const EMPTY_EDITOR: Editor = { text: "", cursor: 0, start: 0 };

export type EditAction =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "delete" }
  | {
      readonly kind: "move";
      readonly to: "left" | "right" | "up" | "down" | "home" | "end";
    };

// How the text is shown: in one row that scrolls sideways, as the denial reason is, or wrapped at
// the width with at most `rows` rows in view, as the Prompt is. Only wrapped text has line breaks
// and rows for Up and Down to move between.
export type EditorLayout =
  | { readonly kind: "row"; readonly columns: number }
  | { readonly kind: "wrapped"; readonly columns: number; readonly rows: number };

export interface EditorView {
  // The rows in view, none wider than the layout's columns.
  readonly rows: readonly string[];
  // The index among all the rows of the text of the first row in view.
  readonly firstRow: number;
  // Where the cursor is among the rows in view.
  readonly cursor: { readonly row: number; readonly column: number };
}

export function edit(editor: Editor, action: EditAction, layout: EditorLayout): Editor {
  const { text, cursor } = editor;
  const characters = charactersOf(text);
  let next: { readonly text: string; readonly cursor: number; readonly goal?: number };
  switch (action.kind) {
    case "insert":
      next = {
        text: text.slice(0, cursor) + action.text + text.slice(cursor),
        cursor: cursor + action.text.length,
      };
      break;
    case "backspace": {
      const before = previousBoundary(characters, cursor);
      next = { text: text.slice(0, before) + text.slice(cursor), cursor: before };
      break;
    }
    case "delete":
      next = {
        text: text.slice(0, cursor) + text.slice(nextBoundary(characters, text, cursor)),
        cursor,
      };
      break;
    case "move":
      if (action.to === "up" || action.to === "down") {
        if (layout.kind === "row") {
          return editor;
        }
        const { stops } = wrapRows(text, layout.columns);
        next = { text, ...vertical(stops, cursor, editor.goal, action.to === "up" ? -1 : 1) };
      } else {
        next = { text, cursor: moved(characters, text, cursor, action.to) };
      }
      break;
    default: {
      const unhandled: never = action;
      throw new Error(`Unhandled edit action: ${JSON.stringify(unhandled)}`);
    }
  }
  return laidOut({ ...next, start: editor.start }, layout).editor;
}

export function editorView(editor: Editor, layout: EditorLayout): EditorView {
  // The layout may have changed since the last edit, as when the terminal is resized.
  return laidOut(editor, layout).view;
}

function moved(
  characters: readonly Character[],
  text: string,
  cursor: number,
  to: "left" | "right" | "home" | "end",
): number {
  switch (to) {
    case "left":
      return previousBoundary(characters, cursor);
    case "right":
      return nextBoundary(characters, text, cursor);
    // The start and the end of the line the cursor is on.
    case "home":
      return cursor === 0 ? 0 : text.lastIndexOf("\n", cursor - 1) + 1;
    case "end": {
      const lineBreak = text.indexOf("\n", cursor);
      return lineBreak === -1 ? text.length : lineBreak;
    }
  }
}

// The editor with its cursor on a character boundary and the part in view moved to show the
// cursor, and what is in view.
function laidOut(editor: Editor, layout: EditorLayout): { editor: Editor; view: EditorView } {
  return layout.kind === "row" ? oneRow(editor, layout.columns) : wrapped(editor, layout);
}

// One row that scrolls sideways. The cursor's cell stays in view, and `start` moves as little as
// possible. Once the rest of the text from an earlier character fits in the row, as after deleting
// from the end, the row shows it again rather than leaving the start of the row empty.
function oneRow(editor: Editor, columns: number): { editor: Editor; view: EditorView } {
  const { text } = editor;
  const width = Math.max(1, columns);
  const characters = charactersOf(text);
  // offsets[i] is the width of the characters before the i-th.
  const offsets = [0];
  for (const character of characters) {
    offsets.push((offsets.at(-1) ?? 0) + character.width);
  }
  const offset = (index: number) => offsets[index] ?? 0;
  const at = firstAtOrAfter(characters, editor.cursor, byIndex);
  // The cursor takes the cell of the character under it, or one cell after the last character.
  const cursorWidth = characters[at]?.width || 1;
  let first = Math.min(firstAtOrAfter(characters, editor.start, byIndex), at);
  while (first < at && offset(at) - offset(first) + cursorWidth > width) {
    first += 1;
  }
  // The cell after the last character counts, because the cursor may move there.
  while (first > 0 && offset(characters.length) - offset(first - 1) + 1 <= width) {
    first -= 1;
  }
  let last = first;
  while (last < characters.length && offset(last + 1) - offset(first) <= width) {
    last += 1;
  }
  const start = characters[first]?.index ?? text.length;
  const end = characters[last]?.index ?? text.length;
  const cursor = characters[at]?.index ?? text.length;
  return {
    editor: withGoal({ text, cursor, start }, undefined),
    view: {
      rows: [text.slice(start, end)],
      firstRow: 0,
      cursor: { row: 0, column: offset(at) - offset(first) },
    },
  };
}

// Rows wrapped at the width, at most `layout.rows` of them in view. The top row in view moves as
// little as possible to keep the cursor's row in view, and moves up again once the rows after it
// no longer fill the view.
function wrapped(
  editor: Editor,
  layout: Extract<EditorLayout, { kind: "wrapped" }>,
): { editor: Editor; view: EditorView } {
  const { text } = editor;
  const { rows, stops } = wrapRows(text, layout.columns);
  const stop = stops[firstAtOrAfter(stops, editor.cursor, byIndex)] ?? lastOf(stops);
  const inView = Math.min(rows.length, Math.max(1, layout.rows));
  // The row that holds `start`: the last one starting at or before it.
  let top = Math.max(0, firstAtOrAfter(rows, editor.start + 1, (row) => row.start) - 1);
  top = Math.min(top, stop.row);
  top = Math.max(top, stop.row - inView + 1);
  top = Math.min(top, rows.length - inView);
  const start = rows[top]?.start ?? 0;
  return {
    editor: withGoal({ text, cursor: stop.index, start }, editor.goal),
    view: {
      rows: rows.slice(top, top + inView).map((row) => row.text),
      firstRow: top,
      cursor: { row: stop.row - top, column: stop.column },
    },
  };
}

// A place the cursor can be, before a character or after the last one, and where it is shown.
interface Stop {
  readonly index: number;
  readonly row: number;
  readonly column: number;
}

interface WrappedRows {
  // The character each row starts at and the text it shows.
  readonly rows: readonly { readonly start: number; readonly text: string }[];
  // Every place the cursor can be, in the order of the text.
  readonly stops: readonly Stop[];
}

// Lays out text in rows `columns` wide: a line break ends a row, and a character that would stick
// out past the width starts the next one. The cursor before a line break or at the end of the text
// takes a cell after the last character of its line, so a line that fills its row is followed by a
// row of its own for that cell, as a terminal moves the cursor to the next line.
function wrapRows(text: string, columns: number): WrappedRows {
  if (wrapCache?.text === text && wrapCache.columns === columns) {
    return wrapCache.result;
  }
  const width = Math.max(1, columns);
  const rows: { start: number; text: string }[] = [];
  const stops: Stop[] = [];
  let rowStart = 0;
  let rowText = "";
  let column = 0;
  const endRow = (nextStart: number) => {
    rows.push({ start: rowStart, text: rowText });
    rowStart = nextStart;
    rowText = "";
    column = 0;
  };
  for (const character of charactersOf(text)) {
    const lineBreak = character.text === "\n";
    const cell = lineBreak ? 1 : character.width;
    if (column > 0 && column + cell > width) {
      endRow(character.index);
    }
    stops.push({ index: character.index, row: rows.length, column });
    if (lineBreak) {
      endRow(character.index + character.text.length);
    } else {
      rowText += character.text;
      column += character.width;
    }
  }
  if (column > 0 && column + 1 > width) {
    endRow(text.length);
  }
  stops.push({ index: text.length, row: rows.length, column });
  rows.push({ start: rowStart, text: rowText });
  const result = { rows, stops };
  wrapCache = { text, columns, result };
  return result;
}

let wrapCache: { text: string; columns: number; result: WrappedRows } | undefined;

// The cursor one row up or down, on the last place in that row that does not pass the goal
// column: the end of a shorter line, or the start of a wide character that covers the column. On
// the first or the last row it stays where it is.
function vertical(
  stops: readonly Stop[],
  cursor: number,
  goal: number | undefined,
  direction: -1 | 1,
): { cursor: number; goal: number } {
  const stop = stops[firstAtOrAfter(stops, cursor, byIndex)] ?? lastOf(stops);
  const column = goal ?? stop.column;
  const row = stop.row + direction;
  let index = firstAtOrAfter(stops, row, (candidate) => candidate.row);
  let target = stops[index];
  if (target?.row !== row) {
    return { cursor, goal: column };
  }
  for (let next = stops[index + 1]; next?.row === row && next.column <= column; ) {
    target = next;
    index += 1;
    next = stops[index + 1];
  }
  return { cursor: target.index, goal: column };
}

function withGoal(editor: Editor, goal: number | undefined): Editor {
  return goal === undefined ? editor : { ...editor, goal };
}

// One character as the person sees it: where it starts in the text, and how many columns it takes.
interface Character {
  readonly index: number;
  readonly text: string;
  readonly width: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Segmenting and measuring take most of an edit's time, so each text is laid out once: an edit
// reads the text before it, then lays out the text after it, which the frame then draws.
let charactersCache: { text: string; characters: readonly Character[] } | undefined;

function charactersOf(text: string): readonly Character[] {
  if (charactersCache?.text === text) {
    return charactersCache.characters;
  }
  const characters: Character[] = [];
  for (const { index, segment } of graphemes.segment(text)) {
    characters.push({ index, text: segment, width: widthOf(segment) });
  }
  charactersCache = { text, characters };
  return characters;
}

// string-width takes microseconds for each letter outside ASCII, which adds up over a long paste
// of Vietnamese, so each character's width is measured once.
const widths = new Map<string, number>();
const WIDTHS_KEPT = 4096;

function widthOf(character: string): number {
  let width = widths.get(character);
  if (width === undefined) {
    if (widths.size >= WIDTHS_KEPT) {
      widths.clear();
    }
    width = stringWidth(character);
    widths.set(character, width);
  }
  return width;
}

function previousBoundary(characters: readonly Character[], index: number): number {
  return characters[firstAtOrAfter(characters, index, byIndex) - 1]?.index ?? 0;
}

function nextBoundary(characters: readonly Character[], text: string, index: number): number {
  return characters[firstAtOrAfter(characters, index, byIndex) + 1]?.index ?? text.length;
}

// The position of the first item whose key is at least `value`, or the length when there is none.
// Items are in order of their key.
function firstAtOrAfter<Item>(
  items: readonly Item[],
  value: number,
  key: (item: Item) => number,
): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const item = items[middle];
    if (item !== undefined && key(item) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

const byIndex = (item: { readonly index: number }) => item.index;

function lastOf<Item>(items: readonly Item[]): Item {
  const item = items.at(-1);
  if (item === undefined) {
    throw new Error("Expected at least one item");
  }
  return item;
}
