import { afterEach, describe, expect, it } from "bun:test";
import { type MountedTui, mountTui } from "../src/render.tsx";
import type { TranscriptEntry, TuiHandlers } from "../src/types.ts";
import { createTestTerminal, KEYS, type TestTerminal } from "./support/terminal.ts";

const COLUMNS = 40;
const ROWS = 6;

// Bracketed paste markers, which a terminal puts around pasted text once Ink asks for them.
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const CLEAR_SCREEN = "\u001b[2J";

function unexpectedHandlerCall(): never {
  throw new Error("The TUI called a handler these keys do not reach");
}

const mounted: { tui: MountedTui; terminal: TestTerminal }[] = [];

function mount(transcript: readonly TranscriptEntry[] = [], columns = COLUMNS) {
  const terminal = createTestTerminal(columns, ROWS);
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
  const tui = mountTui({ model: { transcript }, handlers }, terminal.streams);
  mounted.push({ tui, terminal });
  return { tui, terminal, submitted, cancelled };
}

afterEach(async () => {
  for (const { tui, terminal } of mounted.splice(0)) {
    await tui.unmount();
    terminal.dispose();
  }
});

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

  it("does not submit an empty prompt", async () => {
    const { tui, submitted, terminal } = mount();
    await terminal.press(KEYS.enter, "   ", KEYS.enter);
    await tui.flush();
    expect(submitted).toEqual([]);
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
    expect(terminal.takeOutput()).not.toContain(CLEAR_SCREEN);
  });

  it("keeps the typed text while the transcript updates", async () => {
    const { tui, terminal } = mount();
    await terminal.press("Sửa");
    tui.update({ transcript: [{ kind: "user", id: "task", text: "Đang chạy" }] });
    await tui.flush();
    expect(terminal.screen()[0]).toBe("> Đang chạy");
    expect(prompt(terminal)).toBe("> Sửa");
  });

  it("shows the keys under the prompt, the cancel key first", async () => {
    const wide = mount([], 80);
    await wide.tui.flush();
    expect(wide.terminal.screen().at(-1)).toBe("Esc cancel · Enter submit · PgUp/PgDn scroll");

    // A narrow terminal cuts the hint, but not before the cancel key.
    const narrow = mount([], 20);
    await narrow.tui.flush();
    expect(narrow.terminal.screen().at(-1)).toBe("Esc cancel · Enter …");
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
