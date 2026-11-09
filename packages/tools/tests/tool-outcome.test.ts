import { describe, expect, it } from "bun:test";
import { MAX_TOOL_OUTPUT_BYTES, TOOL_OUTPUT_TRUNCATION_MARKER } from "../src/output-budget.ts";
import { success, toolError } from "../src/tool-outcome.ts";

const encoder = new TextEncoder();
const bytesOf = (text: string): number => encoder.encode(text).byteLength;

describe("tool outcomes", () => {
  it("returns a short successful outcome unchanged", () => {
    expect(success("ok")).toEqual({ isError: false, content: "ok" });
  });

  it("flags a successful outcome over the budget as truncated", () => {
    const content = "a".repeat(MAX_TOOL_OUTPUT_BYTES + 1);

    expect(success(content)).toEqual({
      isError: false,
      content: "a".repeat(20_467) + TOOL_OUTPUT_TRUNCATION_MARKER + "a".repeat(20_467),
      truncated: true,
    });
  });

  it("returns a short error unchanged", () => {
    const error = { code: "NOT_FOUND", message: "gone" } as const;

    expect(toolError(error)).toEqual({ isError: true, content: "gone", error });
  });

  it("bounds a long error message, keeps its code, and flags it as truncated", () => {
    const message = "a".repeat(MAX_TOOL_OUTPUT_BYTES + 1);

    const outcome = toolError({ code: "NON_ZERO_EXIT", message });

    if (!outcome.isError) throw new Error("expected an error outcome");
    expect(outcome.truncated).toBe(true);
    expect(outcome.error.code).toBe("NON_ZERO_EXIT");
    expect(outcome.content).toBe(outcome.error.message);
    expect(outcome.content).toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(bytesOf(outcome.content)).toBe(MAX_TOOL_OUTPUT_BYTES);
  });
});
