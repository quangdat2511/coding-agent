import { describe, expect, it } from "bun:test";
import {
  type EditAction,
  type Editor,
  type EditorLayout,
  EMPTY_EDITOR,
  edit,
  editorView,
} from "../src/editor.ts";

// One row that scrolls sideways, as the denial reason is laid out.
const row = (columns: number): EditorLayout => ({ kind: "row", columns });
// Rows wrapped at the width, at most `rows` of them in view, as the Prompt is laid out.
const wrapped = (columns: number, rows = 10): EditorLayout => ({ kind: "wrapped", columns, rows });

const WIDE = row(80);

// Applies the actions in order to an empty editor with the given layout.
function typed(actions: readonly EditAction[], layout: EditorLayout = WIDE): Editor {
  return actions.reduce((editor, action) => edit(editor, action, layout), EMPTY_EDITOR);
}

const insert = (text: string): EditAction => ({ kind: "insert", text });
const left: EditAction = { kind: "move", to: "left" };
const right: EditAction = { kind: "move", to: "right" };
const up: EditAction = { kind: "move", to: "up" };
const down: EditAction = { kind: "move", to: "down" };
const home: EditAction = { kind: "move", to: "home" };
const end: EditAction = { kind: "move", to: "end" };
const backspace: EditAction = { kind: "backspace" };
const del: EditAction = { kind: "delete" };

// "Sử" with ử written as u, a horn and a hook above: one character the person sees, three code
// points.
const DECOMPOSED = "Sử";
const FAMILY = "👨‍👩‍👧";

describe("edit", () => {
  it("inserts typed and pasted text at the cursor", () => {
    const editor = typed([insert("Sửa test"), home, right, right, right, insert(" lại")]);
    expect(editor.text).toBe("Sửa lại test");
    expect(editorView(editor, WIDE)).toEqual({
      rows: ["Sửa lại test"],
      firstRow: 0,
      cursor: { row: 0, column: 7 },
    });
  });

  it("moves the cursor by one character as the person sees it", () => {
    const editor = typed([insert(`a${DECOMPOSED}${FAMILY}b`), left, left]);
    expect(editor.text.slice(0, editor.cursor)).toBe(`a${DECOMPOSED}`);
    expect(editorView(editor, WIDE).cursor).toEqual({ row: 0, column: 3 });
    const back = edit(editor, left, WIDE);
    expect(back.text.slice(0, back.cursor)).toBe("aS");
    expect(editorView(back, WIDE).cursor).toEqual({ row: 0, column: 2 });
  });

  it("moves to the start of the line on Home and to its end on End", () => {
    const atStart = typed([insert("abc"), home]);
    expect(atStart.cursor).toBe(0);
    expect(edit(atStart, end, WIDE).cursor).toBe(3);
    // In a text of several lines, the line the cursor is on.
    const lines = typed([insert("ab\ncd\nef"), up, home], wrapped(80));
    expect(lines.cursor).toBe(3);
    expect(edit(lines, end, wrapped(80)).cursor).toBe(5);
  });

  it("stops at either end", () => {
    expect(typed([insert("ab"), right]).cursor).toBe(2);
    expect(typed([insert("ab"), home, left]).cursor).toBe(0);
  });

  it("deletes the character before the cursor on Backspace and after it on Delete", () => {
    const editor = typed([insert(`a${DECOMPOSED}${FAMILY}b`), left, left]);
    expect(edit(editor, backspace, WIDE).text).toBe(`aS${FAMILY}b`);
    expect(edit(editor, del, WIDE).text).toBe(`a${DECOMPOSED}b`);
    // Nothing before the start or after the end.
    expect(typed([insert("ab"), home, backspace]).text).toBe("ab");
    expect(typed([insert("ab"), del]).text).toBe("ab");
  });

  it("takes a paste of 20,000 characters without slowing down", () => {
    // Laying the text out once per edit keeps an edit linear in the length of the text. Measuring
    // it again for each character in view took about 11 seconds here; the bound is far above the
    // linear time so that a slow machine does not fail it.
    const text = "Sửa lỗi đăng nhập ".repeat(1100);
    const begin = performance.now();
    const editor = typed([insert(text), home, end], wrapped(38, 7));
    editorView(editor, wrapped(38, 7));
    typed([insert(text), home, end], row(38));
    expect(performance.now() - begin).toBeLessThan(1000);
  });
});

describe("editorView in one row", () => {
  it("shows text wider than its row from where the cursor stays in view", () => {
    // Ten columns: nine characters and the cell the cursor takes after the last one.
    const editor = typed([insert("0123456789abcdef")], row(10));
    expect(editorView(editor, row(10))).toEqual({
      rows: ["789abcdef"],
      firstRow: 0,
      cursor: { row: 0, column: 9 },
    });
  });

  it("scrolls no further than it needs to keep the cursor in view", () => {
    const layout = row(10);
    let editor = typed([insert("0123456789abcdef")], layout);
    // Moving left inside the row leaves the text where it is...
    for (let step = 0; step < 9; step++) {
      editor = edit(editor, left, layout);
    }
    expect(editorView(editor, layout).rows).toEqual(["789abcdef"]);
    expect(editorView(editor, layout).cursor).toEqual({ row: 0, column: 0 });
    // ...and past its left edge shows one more character.
    editor = edit(editor, left, layout);
    expect(editorView(editor, layout).rows).toEqual(["6789abcdef"]);
    // Home shows the start again, cut where the row ends.
    expect(editorView(edit(editor, home, layout), layout).rows).toEqual(["0123456789"]);
  });

  it("measures characters two columns wide", () => {
    // Each 漢 takes two columns, so four of them and the cursor cell need nine.
    const editor = typed([insert("漢漢漢漢漢")], row(9));
    expect(editorView(editor, row(9)).rows).toEqual(["漢漢漢漢"]);
    expect(editorView(editor, row(9)).cursor).toEqual({ row: 0, column: 8 });
    // A wide character that would stick out past the row is left out.
    expect(editorView(edit(editor, home, row(9)), row(9)).rows).toEqual(["漢漢漢漢"]);
  });

  it("shows more of the text again once it is shorter", () => {
    const layout = row(10);
    let editor = typed([insert("0123456789abcdef")], layout);
    for (let step = 0; step < 7; step++) {
      editor = edit(editor, backspace, layout);
    }
    expect(editorView(editor, layout).rows).toEqual(["012345678"]);
  });

  it("ignores Up and Down", () => {
    const editor = typed([insert("abc"), left]);
    expect(edit(editor, up, WIDE)).toEqual(editor);
    expect(edit(editor, down, WIDE)).toEqual(editor);
  });
});

describe("editorView wrapped", () => {
  it("wraps a line at the width of its rows", () => {
    const editor = typed([insert("0123456789abc")], wrapped(5));
    expect(editorView(editor, wrapped(5))).toEqual({
      rows: ["01234", "56789", "abc"],
      firstRow: 0,
      cursor: { row: 2, column: 3 },
    });
  });

  it("gives the cursor after a full row a row of its own", () => {
    const editor = typed([insert("01234")], wrapped(5));
    expect(editorView(editor, wrapped(5))).toEqual({
      rows: ["01234", ""],
      firstRow: 0,
      cursor: { row: 1, column: 0 },
    });
  });

  it("starts a new row at each line break", () => {
    expect(editorView(typed([insert("ab\n\ncd")], wrapped(5)), wrapped(5))).toEqual({
      rows: ["ab", "", "cd"],
      firstRow: 0,
      cursor: { row: 2, column: 2 },
    });
    expect(editorView(typed([insert("ab\n")], wrapped(5)), wrapped(5)).rows).toEqual(["ab", ""]);
  });

  it("keeps a character two columns wide whole", () => {
    const editor = typed([insert("漢漢漢")], wrapped(5));
    expect(editorView(editor, wrapped(5)).rows).toEqual(["漢漢", "漢"]);
    expect(editorView(editor, wrapped(5)).cursor).toEqual({ row: 1, column: 2 });
  });

  it("shows at most its rows, scrolling only as far as the cursor needs", () => {
    const layout = wrapped(10, 3);
    const lines = Array.from({ length: 10 }, (_, index) => `l${index}`).join("\n");
    let editor = typed([insert(lines)], layout);
    expect(editorView(editor, layout)).toEqual({
      rows: ["l7", "l8", "l9"],
      firstRow: 7,
      cursor: { row: 2, column: 2 },
    });
    // Up inside the rows in view leaves them where they are...
    editor = edit(edit(editor, up, layout), up, layout);
    expect(editorView(editor, layout).rows).toEqual(["l7", "l8", "l9"]);
    expect(editorView(editor, layout).cursor).toEqual({ row: 0, column: 2 });
    // ...and past the top row shows one more.
    editor = edit(editor, up, layout);
    expect(editorView(editor, layout).rows).toEqual(["l6", "l7", "l8"]);
    expect(editorView(editor, layout).firstRow).toBe(6);
  });

  it("shows more of the text again once it is shorter", () => {
    const layout = wrapped(10, 3);
    const lines = Array.from({ length: 10 }, (_, index) => `l${index}`).join("\n");
    let editor = typed([insert(lines), up, up], layout);
    expect(editorView(editor, layout).firstRow).toBe(7);
    // Delete takes the two lines after the cursor, which leaves the cursor on the last row.
    for (let step = 0; step < 6; step++) {
      editor = edit(editor, del, layout);
    }
    expect(editorView(editor, layout)).toEqual({
      rows: ["l5", "l6", "l7"],
      firstRow: 5,
      cursor: { row: 2, column: 2 },
    });
  });
});

describe("Up and Down", () => {
  it("move between rows, aiming for the column they started from", () => {
    const layout = wrapped(80);
    let editor = typed([insert("abcdef\nab\nabcdef")], layout);
    editor = edit(editor, up, layout);
    // The middle line is shorter, so the cursor stops at its end...
    expect(editorView(editor, layout).cursor).toEqual({ row: 1, column: 2 });
    // ...and goes back to its column on the line above.
    editor = edit(editor, up, layout);
    expect(editorView(editor, layout).cursor).toEqual({ row: 0, column: 6 });
    // Any other key forgets that column, and Up and Down aim for the column it leaves.
    editor = edit(edit(edit(editor, left, layout), down, layout), down, layout);
    expect(editorView(editor, layout).cursor).toEqual({ row: 2, column: 5 });
  });

  it("move by row inside a wrapped line", () => {
    const layout = wrapped(5);
    const editor = typed([insert("0123456789"), home, down], layout);
    expect(editor.cursor).toBe(5);
    expect(edit(editor, down, layout).cursor).toBe(10);
  });

  it("stop at the first and the last row", () => {
    const layout = wrapped(80);
    const editor = typed([insert("abc"), left], layout);
    expect(edit(editor, up, layout).cursor).toBe(2);
    expect(edit(editor, down, layout).cursor).toBe(2);
  });

  it("land at the start of a character two columns wide that covers the column", () => {
    const layout = wrapped(80);
    const editor = typed([insert("漢漢\nab"), up], layout);
    // Column 2 on the line below is the start of the second 漢.
    expect(editor.cursor).toBe(1);
    const between = typed([insert("漢漢\na"), up], layout);
    // Column 1 is inside the first 漢, so the cursor goes to its start.
    expect(between.cursor).toBe(0);
  });
});
