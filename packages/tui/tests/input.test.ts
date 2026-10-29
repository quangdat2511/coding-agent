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

  it("sends Page Up and Page Down to the viewport, never to the prompt", () => {
    expect(routeKey("prompt", "", { pageUp: true })).toEqual([{ kind: "scroll", direction: -1 }]);
    expect(routeKey("prompt", "", { pageDown: true })).toEqual([{ kind: "scroll", direction: 1 }]);
  });

  it("sends typed text to the prompt, never to the viewport", () => {
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

  it("does nothing for named keys and other Ctrl and Meta combinations", () => {
    // Ink reports an arrow, Tab, Delete, Home or End with empty input.
    expect(routeKey("prompt", "", {})).toEqual([]);
    expect(routeKey("prompt", "a", { ctrl: true })).toEqual([]);
    expect(routeKey("prompt", "a", { meta: true })).toEqual([]);
  });
});

describe("routePaste", () => {
  it("inserts pasted lines into the prompt as one line, without submitting", () => {
    expect(routePaste("prompt", "dong 1\rdong 2\n")).toEqual([
      { kind: "insert", text: "dong 1 dong 2 " },
    ]);
    expect(routePaste("prompt", "\u0007")).toEqual([]);
  });
});
