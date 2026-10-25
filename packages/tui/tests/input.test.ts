import { describe, expect, it } from "bun:test";
import { routeKey, routePaste } from "../src/input.ts";

describe("routeKey", () => {
  it("cancels on Esc and on Ctrl+C", () => {
    expect(routeKey("prompt", "", { escape: true })).toEqual({ kind: "cancel" });
    expect(routeKey("prompt", "c", { ctrl: true })).toEqual({ kind: "cancel" });
  });

  it("submits on Enter and deletes on Backspace", () => {
    expect(routeKey("prompt", "", { return: true })).toEqual({ kind: "submit" });
    expect(routeKey("prompt", "", { backspace: true })).toEqual({ kind: "backspace" });
  });

  it("sends Page Up and Page Down to the viewport, never to the prompt", () => {
    expect(routeKey("prompt", "", { pageUp: true })).toEqual({ kind: "scroll", direction: -1 });
    expect(routeKey("prompt", "", { pageDown: true })).toEqual({ kind: "scroll", direction: 1 });
  });

  it("sends typed text to the prompt, never to the viewport", () => {
    expect(routeKey("prompt", "S", {})).toEqual({ kind: "insert", text: "S" });
    // Characters that arrive together are inserted together.
    expect(routeKey("prompt", "Sửa test", {})).toEqual({ kind: "insert", text: "Sửa test" });
  });

  it("turns line breaks and tabs in pasted text into spaces and drops other control characters", () => {
    expect(routeKey("prompt", "dong 1\rdong 2\r\ndong 3\n\tx\u0007\u009b", {})).toEqual({
      kind: "insert",
      text: "dong 1 dong 2 dong 3  x",
    });
    expect(routeKey("prompt", "\u0007", {})).toEqual({ kind: "ignore" });
  });

  it("ignores named keys and other Ctrl and Meta combinations", () => {
    // Ink reports an arrow, Tab, Delete, Home or End with empty input.
    expect(routeKey("prompt", "", {})).toEqual({ kind: "ignore" });
    expect(routeKey("prompt", "a", { ctrl: true })).toEqual({ kind: "ignore" });
    expect(routeKey("prompt", "a", { meta: true })).toEqual({ kind: "ignore" });
  });
});

describe("routePaste", () => {
  it("inserts pasted lines into the prompt as one line", () => {
    expect(routePaste("prompt", "dong 1\rdong 2\n")).toEqual({
      kind: "insert",
      text: "dong 1 dong 2 ",
    });
    expect(routePaste("prompt", "\u0007")).toEqual({ kind: "ignore" });
  });
});
