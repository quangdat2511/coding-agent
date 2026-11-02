import { afterEach, describe, expect, it } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { KEY_HINTS } from "../src/frame.tsx";
import type { TuiStreams } from "../src/render.tsx";
import type { TranscriptEntry, TuiHandlers } from "../src/types.ts";
import { createTestTerminal, KEYS, REDRAWS_IN_PLACE } from "./support/terminal.ts";
import { mountOn, prompt, unexpectedHandlerCall, unmountTui, viewport } from "./support/tui.ts";

const COLUMNS = 40;
// The height of the whole terminal: the transcript, the Prompt and the key hint.
const SCREEN_ROWS = 6;

// Bracketed paste markers, which a terminal puts around pasted text once Ink asks for them.
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const CLEAR_SCREEN = "\u001b[2J";
// What a terminal sends for Shift+Enter under the kitty keyboard protocol, for Alt+Enter, and for
// Ctrl+J.
const SHIFT_ENTER = "\u001b[13;2u";
const ALT_ENTER = "\u001b\r";
const CTRL_J = "\n";
// The Prompt's row on a terminal SCREEN_ROWS tall.
const PROMPT_ROW = SCREEN_ROWS - 2;

// `screenRows` is the height of the whole terminal. `streams` stands in for its stdin or stdout, as
// when input or output is piped.
function mount(
  transcript: readonly TranscriptEntry[] = [],
  columns = COLUMNS,
  screenRows = SCREEN_ROWS,
  streams: Partial<TuiStreams> = {},
) {
  const terminal = createTestTerminal(columns, screenRows);
  const submitted: string[] = [];
  const cancelled = { count: 0 };
  const handlers: TuiHandlers = {
    onSubmit(text) {
      submitted.push(text);
    },
    onCancel() {
      cancelled.count += 1;
    },
    onApproval: unexpectedHandlerCall,
  };
  const tui = mountOn(terminal, { transcript }, handlers, streams);
  return { tui, terminal, submitted, cancelled };
}

afterEach(unmountTui);

describe("Prompt", () => {
  it("shows typed text and deletes it with Backspace", async () => {
    const { tui, terminal } = mount();
    await terminal.press("Sửa testt", KEYS.backspace);
    await tui.flush();
    expect(prompt(terminal)).toBe("> Sửa test");
  });

  it("deletes a letter typed as a base and combining marks with one Backspace", async () => {
    const { tui, terminal } = mount();
    // "Sử" with ử written as u, a horn and a hook above.
    await terminal.press("Sử", KEYS.backspace);
    await tui.flush();
    expect(prompt(terminal)).toBe("> S");
  });

  it("shows the cursor after the typed text", async () => {
    const { tui, terminal } = mount();
    await terminal.press("Sửa");
    await tui.flush();
    expect(await terminal.cursorAt()).toEqual([PROMPT_ROW, 5]);
  });

  it("inserts at the cursor and deletes on either side of it", async () => {
    const { tui, terminal, submitted } = mount();
    await terminal.press("Sửa test", KEYS.home, KEYS.right, KEYS.right, KEYS.right, " lại");
    await tui.flush();
    expect(prompt(terminal)).toBe("> Sửa lại test");
    // The cursor is on the space before "test".
    expect(await terminal.cursorAt()).toEqual([PROMPT_ROW, 9]);

    // Delete takes the space after the cursor, Backspace the i before it.
    await terminal.press(KEYS.delete, KEYS.backspace, KEYS.end, "!", KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual(["Sửa lạtest!"]);
  });

  it("moves the cursor over a letter typed as a base and combining marks in one step", async () => {
    const { tui, terminal, submitted } = mount();
    // "Sửa" with ử written as u, a horn and a hook above.
    await terminal.press("Su\u031b\u0309a", KEYS.left, KEYS.left, KEYS.delete, "u", KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual(["Sua"]);
  });

  it("never moves the viewport on editing keys, nor the cursor on scroll keys", async () => {
    // 21 rows: the header, then line 1 to line 20, in a viewport of 4 rows.
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const { tui, terminal } = mount([{ kind: "assistant", id: "m-1", text, status: "completed" }]);
    await terminal.press("abc", KEYS.pageUp, KEYS.left);
    await tui.flush();
    const inView = ["line 14", "line 15", "line 16", "line 17"];
    expect(viewport(terminal)).toEqual(inView);
    expect(await terminal.cursorAt()).toEqual([PROMPT_ROW, 4]);

    await terminal.press(KEYS.up, KEYS.down, KEYS.home, KEYS.end, KEYS.delete, KEYS.backspace);
    await tui.flush();
    expect(viewport(terminal)).toEqual(inView);
    await terminal.press(KEYS.home, KEYS.pageDown);
    await tui.flush();
    expect(await terminal.cursorAt()).toEqual([PROMPT_ROW, 2]);
  });

  it("submits the typed task and clears the Prompt", async () => {
    const { tui, terminal, submitted } = mount();
    await terminal.press("Sửa test", KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual(["Sửa test"]);
    expect(prompt(terminal)).toBe(">");
  });

  it("submits text that arrives in the same read as Enter", async () => {
    const { tui, terminal, submitted } = mount();
    // One write, as when the keys were typed while the TUI was busy.
    await terminal.press(`Sửa test${KEYS.enter}`);
    await tui.flush();
    expect(submitted).toEqual(["Sửa test"]);
    expect(prompt(terminal)).toBe(">");
  });

  it("submits keys typed ahead in one read at most once", async () => {
    const { tui, terminal, submitted } = mount();
    // Ink leaves the Enters inside one read, so two tasks typed ahead go as one, in two lines...
    await terminal.press(`task A${KEYS.enter}task B${KEYS.enter}`);
    await tui.flush();
    expect(submitted).toEqual(["task A\ntask B"]);

    // ...and an Enter with more typing after it submits nothing.
    await terminal.press(`task C${KEYS.enter}partial`);
    await tui.flush();
    expect(submitted).toEqual(["task A\ntask B"]);
    await terminal.press(KEYS.enter);
    expect(submitted).toEqual(["task A\ntask B", "task C\npartial"]);
  });

  it("submits pasted lines once when the terminal has no bracketed paste", async () => {
    const { tui, terminal, submitted } = mount();
    // Without bracketed paste, pasted lines arrive as one chunk of typed text.
    await terminal.press("dong 1\rdong 2\rdong 3");
    await tui.flush();
    expect(submitted).toEqual([]);

    // A paste that ends in a line break submits, but only once.
    await terminal.press(`${KEYS.backspace.repeat(20)}a\rb\r`);
    await tui.flush();
    expect(submitted).toEqual(["a\nb"]);
  });

  it("submits the task in NFC form", async () => {
    const { tui, terminal, submitted } = mount();
    // "Sửa" with ử written as u, a horn and a hook above.
    await terminal.press("Sửa", KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual(["Sửa".normalize("NFC")]);
  });

  it("takes an input method's Backspace and replacement letter in one read", async () => {
    const { tui, terminal, submitted } = mount();
    // Telex "Suwra": the input method replaces u with ư, then ư with ử.
    await terminal.press("S", "u", `${KEYS.backspace}ư`, `${KEYS.backspace}ử`, "a", KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual(["Sửa"]);
  });

  it("does not submit a Prompt of only spaces, and clears it", async () => {
    const { tui, submitted, terminal } = mount();
    await terminal.press(KEYS.enter, "   ", KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual([]);
    expect(prompt(terminal)).toBe(">");
  });

  it("submits the task without the spaces and line breaks around it", async () => {
    const { tui, submitted, terminal } = mount();
    // The pasted line break at the end leaves an empty line.
    await terminal.press(`  ${PASTE_START}dong 1\rdong 2\n${PASTE_END}`, KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual(["dong 1\ndong 2"]);
  });

  it("keeps pasted lines without submitting them", async () => {
    const { tui, terminal, submitted } = mount();
    await terminal.press(`${PASTE_START}dong 1\rdong 2${PASTE_END}`);
    await tui.flush();
    expect(submitted).toEqual([]);

    await terminal.press(KEYS.enter);
    expect(submitted).toEqual(["dong 1\ndong 2"]);
  });

  it("wraps a task wider than the Prompt row and keeps the cursor's row in view, without clearing the screen", async () => {
    const { tui, terminal } = mount();
    await tui.flush();
    terminal.takeOutput();
    const task = "0123456789".repeat(6);
    await terminal.press(task);
    await tui.flush();
    // The first 38 characters fill the row after the marker, and the Prompt of this terminal shows
    // one row: the one the cursor is on, with the rest of the task.
    expect(prompt(terminal)).toBe(`  ${task.slice(38)}`);
    expect(await terminal.cursorAt()).toEqual([PROMPT_ROW, 24]);
    // Home shows the start of the task, with the cursor on its first character.
    await terminal.press(KEYS.home);
    await tui.flush();
    expect(prompt(terminal)).toBe(`> ${task.slice(0, 38)}`);
    expect(await terminal.cursorAt()).toEqual([PROMPT_ROW, 2]);
    if (REDRAWS_IN_PLACE) {
      expect(terminal.takeOutput()).not.toContain(CLEAR_SCREEN);
    }
  });

  it("drops the key hint on a terminal of two rows", async () => {
    const { tui, terminal } = mount([{ kind: "user", id: "task", text: "Sửa test" }], COLUMNS, 2);
    await terminal.press("abc");
    await tui.flush();
    expect(terminal.screen()).toEqual(["> Sửa test", "> abc"]);
  });

  it("drops the transcript too on a terminal of one row", async () => {
    const { tui, terminal } = mount([{ kind: "user", id: "task", text: "Sửa test" }], COLUMNS, 1);
    await terminal.press("abc");
    await tui.flush();
    expect(terminal.screen()).toEqual(["> abc"]);
    // The frame fits the screen, so typing redraws it in place.
    if (REDRAWS_IN_PLACE) {
      expect(terminal.takeOutput()).not.toContain(CLEAR_SCREEN);
    }
  });

  it("keeps the typed text while the transcript updates", async () => {
    const { tui, terminal } = mount();
    await terminal.press("Sửa");
    tui.update({ transcript: [{ kind: "user", id: "task", text: "Đang chạy" }] });
    await tui.flush();
    expect(terminal.screen()[0]).toBe("> Đang chạy");
    expect(prompt(terminal)).toBe("> Sửa");
  });

  it("draws without taking input when stdin is not a terminal", async () => {
    // A plain stream, as when input is piped: it cannot be switched to raw mode.
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const transcript = [{ kind: "user", id: "task", text: "Sửa test" }] as const;
    const { tui, terminal } = mount(transcript, COLUMNS, SCREEN_ROWS, { stdin });
    await tui.flush();
    expect(terminal.screen()[0]).toBe("> Sửa test");
    expect(prompt(terminal)).toBe(">");
    await tui.unmount();
    expect(terminal.terminal.buffer.active.type).toBe("normal");
  });

  it("switches stdin to raw mode while it draws on a terminal", async () => {
    const { tui, terminal } = mount();
    await tui.flush();
    expect(terminal.isRawMode()).toBe(true);
  });

  it("leaves stdin out of raw mode when output is piped", async () => {
    // Input still the terminal: nothing is drawn, so the terminal keeps its keys and Ctrl+C still
    // stops the process.
    const stdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }) as unknown as NodeJS.WriteStream;
    const { tui, terminal } = mount([], COLUMNS, SCREEN_ROWS, { stdout });
    await tui.flush();
    expect(terminal.isRawMode()).toBe(false);
  });

  it("shows the keys under the Prompt, both cancel keys first", async () => {
    const { tui, terminal } = mount([], 80);
    await tui.flush();
    expect(terminal.screen().at(-1)).toBe(KEY_HINTS.prompt);
    expect(KEY_HINTS.prompt).toBe(
      "Esc/Ctrl+C cancel · Enter submit · Ctrl+J new line · PgUp/PgDn scroll",
    );
  });

  it("cuts the key hint on a narrow terminal, but not before the cancel keys", async () => {
    const { tui, terminal } = mount([], 20);
    await tui.flush();
    expect(terminal.screen().at(-1)).toBe("Esc/Ctrl+C cancel ·…");
  });
});

describe("Prompt of several lines", () => {
  // The Prompt takes up to 30% of the rows: 3 of these 10.
  const TALL = 10;

  it("starts a line on Shift+Enter, Alt+Enter and Ctrl+J, and submits every line on Enter", async () => {
    const { tui, terminal, submitted } = mount([], COLUMNS, TALL);
    await terminal.press("dong 1", SHIFT_ENTER, "dong 2", ALT_ENTER, "dong 3");
    await tui.flush();
    expect(terminal.screen().slice(6, 9)).toEqual(["> dong 1", "  dong 2", "  dong 3"]);
    expect(await terminal.cursorAt()).toEqual([8, 8]);

    // A fourth line is more than the Prompt shows, so its rows move up to keep the cursor in view.
    await terminal.press(CTRL_J, "dong 4");
    await tui.flush();
    expect(terminal.screen().slice(6, 9)).toEqual(["  dong 2", "  dong 3", "  dong 4"]);

    await terminal.press(KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual(["dong 1\ndong 2\ndong 3\ndong 4"]);
    expect(prompt(terminal)).toBe(">");
  });

  it("takes rows from the transcript as it grows and gives them back once submitted", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const { tui, terminal } = mount(
      [{ kind: "assistant", id: "m-1", text, status: "completed" }],
      COLUMNS,
      TALL,
    );
    await tui.flush();
    terminal.takeOutput();
    expect(terminal.screen().slice(0, 8).at(-1)).toBe("line 20");
    await terminal.press("a", CTRL_J, "b");
    await tui.flush();
    // The transcript keeps following its last row, now on the row above the Prompt.
    expect(terminal.screen().slice(0, 8)).toEqual([
      "line 14",
      "line 15",
      "line 16",
      "line 17",
      "line 18",
      "line 19",
      "line 20",
      "> a",
    ]);
    await terminal.press(KEYS.enter);
    await tui.flush();
    expect(terminal.screen().slice(0, 8).at(-1)).toBe("line 20");
    if (REDRAWS_IN_PLACE) {
      expect(terminal.takeOutput()).not.toContain(CLEAR_SCREEN);
    }
  });

  it("moves between lines on Up and Down", async () => {
    const { tui, terminal, submitted } = mount([], COLUMNS, TALL);
    await terminal.press("abc", CTRL_J, "de", KEYS.up, "X", KEYS.down, "Y");
    await tui.flush();
    expect(terminal.screen().slice(7, 9)).toEqual(["> abXc", "  deY"]);
    expect(await terminal.cursorAt()).toEqual([8, 5]);
    await terminal.press(KEYS.enter);
    expect(submitted).toEqual(["abXc\ndeY"]);
  });

  it("shows pasted lines as they were", async () => {
    const { tui, terminal } = mount([], COLUMNS, TALL);
    await terminal.press(
      `${PASTE_START}Sửa hàm login:\r1. kiểm tra email\r2. trả lỗi 400${PASTE_END}`,
    );
    await tui.flush();
    expect(terminal.screen().slice(6, 9)).toEqual([
      "> Sửa hàm login:",
      "  1. kiểm tra email",
      "  2. trả lỗi 400",
    ]);
  });

  it("shows a submitted task of several lines in the transcript", async () => {
    const { tui, terminal } = mount([], COLUMNS, TALL);
    tui.update({ transcript: [{ kind: "user", id: "task", text: "dong 1\ndong 2" }] });
    await tui.flush();
    expect(terminal.screen().slice(0, 2)).toEqual(["> dong 1", "  dong 2"]);
  });
});

describe("kitty keyboard protocol", () => {
  it("is asked for when asked to, and turned off again on exit", async () => {
    const terminal = createTestTerminal(COLUMNS, SCREEN_ROWS);
    const tui = mountOn(terminal, { transcript: [] }, undefined, {}, { kittyKeyboard: true });
    await tui.flush();
    expect(terminal.takeOutput()).toContain("\u001b[?u");
    // The terminal answers with the flags it has on, and Ink turns the protocol on.
    await terminal.press("\u001b[?0u");
    await tui.flush();
    expect(terminal.takeOutput()).toContain("\u001b[>1u");
    // The answer is not a key: nothing reaches the Prompt.
    expect(prompt(terminal)).toBe(">");
    await tui.unmount();
    expect(terminal.takeOutput()).toContain("\u001b[<u");
  });

  it("is left alone otherwise", async () => {
    const { tui, terminal } = mount();
    await tui.flush();
    await tui.unmount();
    expect(terminal.takeOutput()).not.toContain("\u001b[?u");
  });
});

describe("cancel keys", () => {
  it("call onCancel on Esc and leave the typed text in the Prompt", async () => {
    const { tui, terminal, cancelled } = mount();
    await terminal.press("abc", KEYS.escape);
    await tui.flush();
    expect(cancelled.count).toBe(1);
    expect(prompt(terminal)).toBe("> abc");
  });

  it("call onCancel on Ctrl+C and keep the TUI running", async () => {
    const { tui, terminal, cancelled } = mount();
    await terminal.press(KEYS.ctrlC, "abc");
    await tui.flush();
    expect(cancelled.count).toBe(1);
    // Ink's own Ctrl+C handling would have exited and restored the main screen.
    expect(terminal.terminal.buffer.active.type).toBe("alternate");
    expect(prompt(terminal)).toBe("> abc");
  });

  it("cancel while scrolled up without moving the viewport", async () => {
    // 21 rows: the header, then line 1 to line 20, in a viewport of 4 rows.
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const { tui, terminal, cancelled } = mount([
      { kind: "assistant", id: "m-1", text, status: "streaming" },
    ]);
    await terminal.press(KEYS.pageUp);
    await tui.flush();
    const inView = ["line 14", "line 15", "line 16", "line 17"];
    expect(viewport(terminal)).toEqual(inView);

    await terminal.press(KEYS.escape);
    await tui.flush();
    expect(cancelled.count).toBe(1);
    expect(viewport(terminal)).toEqual(inView);
  });
});
