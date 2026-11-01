import { describe, expect, it } from "bun:test";
import { routeKey, routePaste } from "../src/input.ts";

describe("routeKey", () => {
  it("cancels on Esc and on Ctrl+C", () => {
    expect(routeKey("prompt", "", { escape: true })).toEqual([{ kind: "cancel" }]);
    expect(routeKey("prompt", "c", { ctrl: true })).toEqual([{ kind: "cancel" }]);
  });

  it("submits on Enter and deletes on Backspace", () => {
    expect(routeKey("prompt", "", { return: true })).toEqual([{ kind: "submit" }]);
    expect(routeKey("prompt", "", { backspace: true })).toEqual([{ kind: "backspace" }]);
  });

  it("sends Page Up and Page Down to the viewport, never to the Prompt", () => {
    expect(routeKey("prompt", "", { pageUp: true })).toEqual([{ kind: "scroll", direction: -1 }]);
    expect(routeKey("prompt", "", { pageDown: true })).toEqual([{ kind: "scroll", direction: 1 }]);
  });

  it("sends typed text to the Prompt, never to the viewport", () => {
    expect(routeKey("prompt", "S", {})).toEqual([{ kind: "insert", text: "S" }]);
    // Characters that arrive together are inserted together.
    expect(routeKey("prompt", "Sửa test", {})).toEqual([{ kind: "insert", text: "Sửa test" }]);
  });

  it("submits a chunk of typed text that ends in Enter", () => {
    // Keys typed ahead while the TUI is busy, Enter included.
    expect(routeKey("prompt", "Sửa test\r", {})).toEqual([
      { kind: "insert", text: "Sửa test" },
      { kind: "submit" },
    ]);
  });

  it("submits a chunk at most once, so a paste without bracketed paste starts one task", () => {
    // Line breaks inside the chunk become spaces.
    expect(routeKey("prompt", "a\rb\rc", {})).toEqual([{ kind: "insert", text: "a b c" }]);
    expect(routeKey("prompt", "dong 1\r\ndong 2", {})).toEqual([
      { kind: "insert", text: "dong 1 dong 2" },
    ]);
    // Only a line break at the end acts as Enter.
    expect(routeKey("prompt", "a\rb\r", {})).toEqual([
      { kind: "insert", text: "a b" },
      { kind: "submit" },
    ]);
  });

  it("submits tasks typed ahead in one chunk as one, and only when the chunk ends in Enter", () => {
    // Keys typed ahead look like a paste: two tasks, each with its Enter, go as one...
    expect(routeKey("prompt", "task A\rtask B\r", {})).toEqual([
      { kind: "insert", text: "task A task B" },
      { kind: "submit" },
    ]);
    // ...and an Enter with more typing after it submits nothing.
    expect(routeKey("prompt", "task A\rpartial", {})).toEqual([
      { kind: "insert", text: "task A partial" },
    ]);
  });

  it("turns line feeds and tabs in typed text into spaces and drops other control characters", () => {
    expect(routeKey("prompt", "dong 1\ndong 2\n\tx\u0007\u009b", {})).toEqual([
      { kind: "insert", text: "dong 1 dong 2  x" },
    ]);
    expect(routeKey("prompt", "\u0007", {})).toEqual([]);
  });

  it("moves the cursor on Left, Right, Home and End and deletes after it on Delete", () => {
    expect(routeKey("prompt", "", { leftArrow: true })).toEqual([{ kind: "move", to: "left" }]);
    expect(routeKey("prompt", "", { rightArrow: true })).toEqual([{ kind: "move", to: "right" }]);
    expect(routeKey("prompt", "", { home: true })).toEqual([{ kind: "move", to: "home" }]);
    expect(routeKey("prompt", "", { end: true })).toEqual([{ kind: "move", to: "end" }]);
    expect(routeKey("prompt", "", { delete: true })).toEqual([{ kind: "delete" }]);
  });

  it("does nothing for other named keys and other Ctrl and Meta combinations", () => {
    // Ink reports Up, Down or Tab with empty input.
    expect(routeKey("prompt", "", {})).toEqual([]);
    expect(routeKey("prompt", "a", { ctrl: true })).toEqual([]);
    expect(routeKey("prompt", "a", { meta: true })).toEqual([]);
  });
});

describe("routeKey in the Approval overlay", () => {
  it("allows on y and denies on n, in either case", () => {
    expect(routeKey("approval", "y", {})).toEqual([{ kind: "allow" }]);
    expect(routeKey("approval", "Y", {})).toEqual([{ kind: "allow" }]);
    expect(routeKey("approval", "n", {})).toEqual([{ kind: "deny" }]);
    expect(routeKey("approval", "N", {})).toEqual([{ kind: "deny" }]);
  });

  it("decides nothing on Enter or on other text, so keys typed ahead never allow", () => {
    expect(routeKey("approval", "", { return: true })).toEqual([]);
    expect(routeKey("approval", "\r", {})).toEqual([]);
    expect(routeKey("approval", "yes", {})).toEqual([]);
    expect(routeKey("approval", "x", {})).toEqual([]);
    expect(routeKey("approval", "y", { ctrl: true })).toEqual([]);
  });

  it("still cancels and scrolls the transcript underneath", () => {
    expect(routeKey("approval", "", { escape: true })).toEqual([{ kind: "cancel" }]);
    expect(routeKey("approval", "", { pageUp: true })).toEqual([{ kind: "scroll", direction: -1 }]);
    expect(routeKey("approval", "", { pageDown: true })).toEqual([
      { kind: "scroll", direction: 1 },
    ]);
  });

  it("ignores pasted text", () => {
    expect(routePaste("approval", "y")).toEqual([]);
  });
});

describe("routeKey in the denial reason", () => {
  it("edits the reason with the same keys as the Prompt", () => {
    expect(routeKey("reason", "abc", {})).toEqual([{ kind: "insert", text: "abc" }]);
    expect(routeKey("reason", "", { backspace: true })).toEqual([{ kind: "backspace" }]);
    expect(routeKey("reason", "", { delete: true })).toEqual([{ kind: "delete" }]);
    expect(routeKey("reason", "", { leftArrow: true })).toEqual([{ kind: "move", to: "left" }]);
    expect(routeKey("reason", "", { home: true })).toEqual([{ kind: "move", to: "home" }]);
  });

  it("submits the reason on Enter", () => {
    expect(routeKey("reason", "", { return: true })).toEqual([{ kind: "submit" }]);
    expect(routeKey("reason", "too risky\r", {})).toEqual([
      { kind: "insert", text: "too risky" },
      { kind: "submit" },
    ]);
  });

  it("keeps the cancel and scroll keys, and inserts pasted text as one line", () => {
    expect(routeKey("reason", "", { escape: true })).toEqual([{ kind: "cancel" }]);
    expect(routeKey("reason", "", { pageUp: true })).toEqual([{ kind: "scroll", direction: -1 }]);
    expect(routePaste("reason", "a\rb")).toEqual([{ kind: "insert", text: "a b" }]);
  });
});

describe("routePaste", () => {
  it("inserts pasted lines into the Prompt as one line, without submitting", () => {
    expect(routePaste("prompt", "dong 1\rdong 2\n")).toEqual([
      { kind: "insert", text: "dong 1 dong 2 " },
    ]);
    expect(routePaste("prompt", "\u0007")).toEqual([]);
  });
});
