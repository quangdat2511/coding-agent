import { afterEach, describe, expect, it } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import type { TuiStreams } from "../src/render.tsx";
import type { TranscriptEntry, TuiHandlers } from "../src/types.ts";
import {
  createTestTerminal,
  KEYS,
  REDRAWS_IN_PLACE,
  type TestTerminal,
} from "./support/terminal.ts";
import { mountOn, unexpectedHandlerCall, unmountTui } from "./support/tui.ts";

const COLUMNS = 40;
const ROWS = 6;

// Bracketed paste markers, which a terminal puts around pasted text once Ink asks for them.
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const CLEAR_SCREEN = "\u001b[2J";

// `streams` stands in for the terminal's stdin or stdout, as when input or output is piped.
function mount(
  transcript: readonly TranscriptEntry[] = [],
  columns = COLUMNS,
  rows = ROWS,
  streams: Partial<TuiStreams> = {},
) {
  const terminal = createTestTerminal(columns, rows);
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

// The prompt is the row above the key hint, at the bottom of the screen.
function prompt(terminal: TestTerminal): string | undefined {
  return terminal.screen().at(-2);
}

describe("prompt", () => {
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

  it("submits the typed task and clears the prompt", async () => {
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
    // Ink leaves the Enters inside one read, so two tasks typed ahead go as one...
    await terminal.press(`task A${KEYS.enter}task B${KEYS.enter}`);
    await tui.flush();
    expect(submitted).toEqual(["task A task B"]);

    // ...and an Enter with more typing after it submits nothing.
    await terminal.press(`task C${KEYS.enter}partial`);
    await tui.flush();
    expect(submitted).toEqual(["task A task B"]);
    expect(prompt(terminal)).toBe("> task C partial");
  });

  it("submits pasted lines once when the terminal has no bracketed paste", async () => {
    const { tui, terminal, submitted } = mount();
    // Without bracketed paste, pasted lines arrive as one chunk of typed text.
    await terminal.press("dong 1\rdong 2\rdong 3");
    await tui.flush();
    expect(submitted).toEqual([]);
    expect(prompt(terminal)).toBe("> dong 1 dong 2 dong 3");

    // A paste that ends in a line break submits, but only once.
    await terminal.press(`${KEYS.backspace.repeat(20)}a\rb\r`);
    await tui.flush();
    expect(submitted).toEqual(["a b"]);
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

  it("does not submit a prompt of only spaces, and clears it", async () => {
    const { tui, submitted, terminal } = mount();
    await terminal.press(KEYS.enter, "   ", KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual([]);
    expect(prompt(terminal)).toBe(">");
  });

  it("submits the task without the spaces around it", async () => {
    const { tui, submitted, terminal } = mount();
    // The pasted line break at the end leaves a space.
    await terminal.press(`  ${PASTE_START}dong 1\rdong 2\n${PASTE_END}`, KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual(["dong 1 dong 2"]);
  });

  it("takes pasted lines as one line without submitting them", async () => {
    const { tui, terminal, submitted } = mount();
    await terminal.press(`${PASTE_START}dong 1\rdong 2${PASTE_END}`);
    await tui.flush();
    expect(prompt(terminal)).toBe("> dong 1 dong 2");
    expect(submitted).toEqual([]);

    await terminal.press(KEYS.enter);
    expect(submitted).toEqual(["dong 1 dong 2"]);
  });

  it("shows the end of a task wider than the prompt row, without clearing the screen", async () => {
    const { tui, terminal } = mount();
    await tui.flush();
    terminal.takeOutput();
    const task = "0123456789".repeat(6);
    await terminal.press(task);
    await tui.flush();
    // The 38 columns after the marker hold an ellipsis and the last 37 characters.
    expect(prompt(terminal)).toBe(`> …${task.slice(-37)}`);
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
    const { tui, terminal } = mount(transcript, COLUMNS, ROWS, { stdin });
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
    const { tui, terminal } = mount([], COLUMNS, ROWS, { stdout });
    await tui.flush();
    expect(terminal.isRawMode()).toBe(false);
  });

  it("shows the keys under the prompt, both cancel keys first", async () => {
    const { tui, terminal } = mount([], 80);
    await tui.flush();
    expect(terminal.screen().at(-1)).toBe("Esc/Ctrl+C cancel · Enter submit · PgUp/PgDn scroll");
  });

  it("cuts the key hint on a narrow terminal, but not before the cancel keys", async () => {
    const { tui, terminal } = mount([], 20);
    await tui.flush();
    expect(terminal.screen().at(-1)).toBe("Esc/Ctrl+C cancel ·…");
  });
});

describe("cancel keys", () => {
  it("call onCancel on Esc and leave the typed text in the prompt", async () => {
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
    const viewport = ["line 14", "line 15", "line 16", "line 17"];
    expect(terminal.screen().slice(0, -2)).toEqual(viewport);

    await terminal.press(KEYS.escape);
    await tui.flush();
    expect(cancelled.count).toBe(1);
    expect(terminal.screen().slice(0, -2)).toEqual(viewport);
  });
});
