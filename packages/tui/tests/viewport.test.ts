import { afterEach, describe, expect, it } from "bun:test";
import { FOOTER_HEIGHT } from "../src/frame.tsx";
import type { TranscriptEntry } from "../src/types.ts";
import {
  createTestTerminal,
  KEYS,
  REDRAWS_IN_PLACE,
  type TestTerminal,
} from "./support/terminal.ts";
import { mountOn, prompt, unmountTui, viewport } from "./support/tui.ts";

const COLUMNS = 40;
// The height of the viewport. The terminal also has the Prompt and the key hint under it.
const VIEWPORT_ROWS = 10;

// ESC[2J clears the screen and ESC[3J the scrollback: Ink sends both whenever a frame is taller than
// the screen, so neither may appear while the viewport keeps frames within it.
const CLEAR_SCREEN = "\u001b[2J";
const CLEAR_SCROLLBACK = "\u001b[3J";

// `viewportRows` is the height of the viewport: the terminal also has the Prompt and the key hint
// below it.
function mount(
  transcript: readonly TranscriptEntry[],
  columns = COLUMNS,
  viewportRows = VIEWPORT_ROWS,
) {
  const terminal = createTestTerminal(columns, viewportRows + FOOTER_HEIGHT);
  // No key these tests press reaches a handler.
  const tui = mountOn(terminal, { transcript });
  return { tui, terminal };
}

function resize(terminal: TestTerminal, columns: number, viewportRows: number) {
  terminal.resize(columns, viewportRows + FOOTER_HEIGHT);
}

afterEach(unmountTui);

// "line first" through "line last", one per row.
function lines(first: number, last: number): string[] {
  return Array.from({ length: last - first + 1 }, (_, index) => `line ${first + index}`);
}

// An assistant message of `count` short lines: its header row, then "line 1" to "line count".
function message(id: string, count: number, status: "streaming" | "completed" = "completed") {
  return { kind: "assistant", id, text: lines(1, count).join("\n"), status } as const;
}

describe("transcript viewport", () => {
  it("shows the last screenful and scrolls up and down through the rest", async () => {
    // 31 rows: the header, then line 1 to line 30.
    const { tui, terminal } = mount([message("m-1", 30)]);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(21, 30));

    tui.scrollBy(-5);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(16, 25));

    // Scrolling stops at the first row.
    tui.scrollBy(-100);
    await tui.flush();
    expect(viewport(terminal)).toEqual(["assistant [completed]", ...lines(1, 9)]);

    tui.scrollBy(3);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(3, 12));

    // ...and at the last.
    tui.scrollBy(100);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(21, 30));
  });

  it("moves a page at a time with Page Up and Page Down, keeping one row in view", async () => {
    // 31 rows: the header, then line 1 to line 30.
    const { tui, terminal } = mount([message("m-1", 30)]);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(21, 30));

    // A page is the viewport less one row, so line 21 stays in view.
    await terminal.press(KEYS.pageUp);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(12, 21));

    await terminal.press(KEYS.pageUp, KEYS.pageUp);
    await tui.flush();
    expect(viewport(terminal)).toEqual(["assistant [completed]", ...lines(1, 9)]);

    // Back at the bottom, the view follows new content again.
    await terminal.press(KEYS.pageDown, KEYS.pageDown, KEYS.pageDown);
    tui.update({ transcript: [message("m-1", 33)] });
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(24, 33));
  });

  it("does not scroll while the terminal has no row for the transcript", async () => {
    const { tui, terminal } = mount([message("m-1", 30, "streaming")]);
    // One row holds only the Prompt.
    terminal.resize(COLUMNS, 1);
    await terminal.press(KEYS.pageUp);
    tui.scrollBy(-5);
    tui.update({ transcript: [message("m-1", 40, "streaming")] });

    // Grown again, the view still follows the newest rows.
    resize(terminal, COLUMNS, VIEWPORT_ROWS);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(31, 40));
  });

  it("sends typing to the Prompt and scroll keys to the viewport", async () => {
    const { tui, terminal } = mount([message("m-1", 30)]);
    await terminal.press(KEYS.pageUp);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(12, 21));

    // Typing reaches the Prompt and leaves the viewport where it was.
    await terminal.press("abc");
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(12, 21));
    expect(prompt(terminal)).toBe("> abc");

    // A scroll key moves the viewport and leaves the Prompt as it was.
    await terminal.press(KEYS.pageDown);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(21, 30));
    expect(prompt(terminal)).toBe("> abc");
  });

  it("neither scrolls nor types on the arrow keys", async () => {
    const { tui, terminal } = mount([message("m-1", 30)]);
    await terminal.press(KEYS.pageUp);
    await tui.flush();

    // Up and Down move the cursor between the Prompt's rows, and never scroll the transcript.
    await terminal.press(KEYS.up, KEYS.down);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(12, 21));
    expect(prompt(terminal)).toBe(">");
  });

  it("does not scroll a transcript that fits on the screen", async () => {
    const { tui, terminal } = mount([message("m-1", 3)]);
    await tui.flush();
    const screen = ["assistant [completed]", ...lines(1, 3), ...Array(6).fill("")];
    expect(viewport(terminal)).toEqual(screen);

    tui.scrollBy(-2);
    await tui.flush();
    expect(viewport(terminal)).toEqual(screen);
  });

  it("follows new content at the bottom and holds still while scrolled up", async () => {
    const { tui, terminal } = mount([message("m-1", 30, "streaming")]);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(21, 30));

    // At the bottom, the view follows the message as it streams.
    tui.update({ transcript: [message("m-1", 33, "streaming")] });
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(24, 33));

    tui.scrollBy(-5);
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(19, 28));

    // Scrolled up, neither a longer message nor a new entry moves the view.
    tui.update({ transcript: [message("m-1", 40)] });
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(19, 28));

    const call = { kind: "tool_call", id: "c-1", toolName: "bash", summary: "bun test" } as const;
    tui.update({ transcript: [message("m-1", 40), { ...call, status: "queued" }] });
    await tui.flush();
    expect(viewport(terminal)).toEqual(lines(19, 28));

    // Back at the bottom, it follows again.
    tui.scrollBy(100);
    await tui.flush();
    expect(viewport(terminal)).toEqual([...lines(33, 40), "", "bash bun test [queued]"]);

    tui.update({
      transcript: [
        message("m-1", 40),
        { ...call, status: "succeeded", result: { content: "2 pass", isError: false } },
      ],
    });
    await tui.flush();
    expect(viewport(terminal)).toEqual([
      ...lines(34, 40),
      "",
      "bash bun test [succeeded]",
      "  2 pass",
    ]);
  });

  it("redraws in place without clearing the screen or the scrollback", async () => {
    const { tui, terminal } = mount([message("m-1", 30, "streaming")]);
    await tui.flush();
    terminal.takeOutput();

    const steps: { act: () => void; screen: string[] }[] = [
      ...[31, 32, 33].map((count) => ({
        act: () => tui.update({ transcript: [message("m-1", count, "streaming")] }),
        screen: lines(count - 9, count),
      })),
      { act: () => tui.scrollBy(-20), screen: lines(4, 13) },
      { act: () => tui.update({ transcript: [message("m-1", 50)] }), screen: lines(4, 13) },
      { act: () => tui.scrollBy(100), screen: lines(41, 50) },
      { act: () => tui.update({ transcript: [message("m-1", 3)] }), screen: shortScreen() },
    ];
    for (const step of steps) {
      step.act();
      await tui.flush();
      expect(viewport(terminal)).toEqual(step.screen);
      const output = terminal.takeOutput();
      if (REDRAWS_IN_PLACE) {
        expect(output).not.toContain(CLEAR_SCREEN);
        expect(output).not.toContain(CLEAR_SCROLLBACK);
      }
    }
    expect(terminal.terminal.buffer.active.type).toBe("alternate");
    expect(terminal.terminal.buffer.active.baseY).toBe(0);

    function shortScreen() {
      return ["assistant [completed]", ...lines(1, 3), ...Array(6).fill("")];
    }
  });

  it("wraps a long user message under its text", async () => {
    const { tui, terminal } = mount(
      [{ kind: "user", id: "task", text: "Sửa test đang lỗi trong src/math.ts" }],
      20,
      4,
    );
    await tui.flush();
    expect(viewport(terminal)).toEqual(["> Sửa test đang lỗi", "  trong src/math.ts", "", ""]);
  });

  it("keeps the same entry at the top and the tail in view across a resize", async () => {
    // Six messages of 60 identical digits: two rows each at 40 columns, three at 25.
    const transcript = [1, 2, 3, 4, 5, 6].map((digit) => ({
      kind: "assistant" as const,
      id: `m-${digit}`,
      text: String(digit).repeat(60),
      status: "completed" as const,
    }));
    const header = "assistant [completed]";
    const at40 = (digit: number) => [header, String(digit).repeat(40), String(digit).repeat(20)];
    const at25 = (digit: number) => [
      header,
      String(digit).repeat(25),
      String(digit).repeat(25),
      String(digit).repeat(10),
    ];
    const { tui, terminal } = mount(transcript);
    await tui.flush();
    expect(viewport(terminal)).toEqual([...at40(4).slice(1), "", ...at40(5), "", ...at40(6)]);

    // Rows 4 to 13: message 2 starts the view.
    tui.scrollBy(-9);
    await tui.flush();
    const scrolled = [...at40(2), "", ...at40(3), "", ...at40(4).slice(0, 2)];
    expect(viewport(terminal)).toEqual(scrolled);

    terminal.takeOutput();
    resize(terminal, 25, VIEWPORT_ROWS);
    await tui.flush();
    expect(viewport(terminal)).toEqual([...at25(2), "", ...at25(3), ""]);

    resize(terminal, COLUMNS, VIEWPORT_ROWS);
    await tui.flush();
    expect(viewport(terminal)).toEqual(scrolled);

    // Following the tail, a narrower terminal still ends on the last row.
    tui.scrollBy(100);
    resize(terminal, 25, VIEWPORT_ROWS);
    await tui.flush();
    expect(viewport(terminal)).toEqual(["", ...at25(5), "", ...at25(6)]);

    // A width change redraws in place.
    const output = terminal.takeOutput();
    if (REDRAWS_IN_PLACE) {
      expect(output).not.toContain(CLEAR_SCREEN);
      expect(output).not.toContain(CLEAR_SCROLLBACK);
    }

    // A shorter terminal also ends on the last row. Ink redraws it in full, clearing the screen,
    // because the previous frame is taller than the screen and the cursor cannot reach its top.
    resize(terminal, 25, 6);
    await tui.flush();
    expect(viewport(terminal)).toEqual([String(5).repeat(10), "", ...at25(6)]);
  });
});
