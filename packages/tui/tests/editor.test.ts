import { describe, expect, it } from "bun:test";
import { type EditAction, type Editor, EMPTY_EDITOR, edit, editorView } from "../src/editor.ts";

const WIDE = 80;

// Applies the actions in order to an empty editor `columns` wide.
function typed(actions: readonly EditAction[], columns = WIDE): Editor {
  return actions.reduce((editor, action) => edit(editor, action, columns), EMPTY_EDITOR);
}

const insert = (text: string): EditAction => ({ kind: "insert", text });
const left: EditAction = { kind: "move", to: "left" };
const right: EditAction = { kind: "move", to: "right" };
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
    expect(editorView(editor, WIDE)).toEqual({ before: "Sửa lại", at: " ", after: "test" });
  });

  it("moves the cursor by one character as the person sees it", () => {
    const editor = typed([insert(`a${DECOMPOSED}${FAMILY}b`), left, left]);
    expect(editorView(editor, WIDE)).toEqual({ before: "aSử", at: FAMILY, after: "b" });
    expect(editorView(edit(editor, left, WIDE), WIDE)).toEqual({
      before: "aS",
      at: "ử",
      after: `${FAMILY}b`,
    });
  });

  it("moves to the start on Home and to the end on End", () => {
    const atStart = typed([insert("abc"), home]);
    expect(editorView(atStart, WIDE)).toEqual({ before: "", at: "a", after: "bc" });
    expect(editorView(edit(atStart, end, WIDE), WIDE)).toEqual({
      before: "abc",
      at: " ",
      after: "",
    });
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
});

describe("editorView", () => {
  it("shows text wider than its row from where the cursor stays in view", () => {
    // Ten columns: nine characters and the cell the cursor takes after the last one.
    const editor = typed([insert("0123456789abcdef")], 10);
    expect(editorView(editor, 10)).toEqual({ before: "789abcdef", at: " ", after: "" });
  });

  it("scrolls no further than it needs to keep the cursor in view", () => {
    const columns = 10;
    let editor = typed([insert("0123456789abcdef")], columns);
    // Moving left inside the row leaves the text where it is...
    for (let step = 0; step < 9; step++) {
      editor = edit(editor, left, columns);
    }
    expect(editorView(editor, columns)).toEqual({ before: "", at: "7", after: "89abcdef" });
    // ...and past its left edge shows one more character.
    editor = edit(editor, left, columns);
    expect(editorView(editor, columns)).toEqual({ before: "", at: "6", after: "789abcdef" });
    // Home shows the start again, cut where the row ends.
    expect(editorView(edit(editor, home, columns), columns)).toEqual({
      before: "",
      at: "0",
      after: "123456789",
    });
  });

  it("measures characters two columns wide", () => {
    // Each 漢 takes two columns, so four of them and the cursor cell need nine.
    const editor = typed([insert("漢漢漢漢漢")], 9);
    expect(editorView(editor, 9)).toEqual({ before: "漢漢漢漢", at: " ", after: "" });
    // A wide character that would stick out past the row is left out.
    expect(editorView(edit(editor, home, 9), 9)).toEqual({ before: "", at: "漢", after: "漢漢漢" });
  });

  it("shows more of the text again once it is shorter", () => {
    const columns = 10;
    let editor = typed([insert("0123456789abcdef")], columns);
    for (let step = 0; step < 7; step++) {
      editor = edit(editor, backspace, columns);
    }
    expect(editorView(editor, columns)).toEqual({ before: "012345678", at: " ", after: "" });
  });
});
