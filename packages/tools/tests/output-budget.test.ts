import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import {
  boundToolOutput,
  MAX_TOOL_OUTPUT_BYTES,
  TOOL_OUTPUT_TRUNCATION_MARKER,
} from "../src/output-budget.ts";

// Buffer.from is byte-exact on the pinned Bun; TextEncoder.encode undercounts some long ropes
// there, which is the runtime bug the helper works around.
const bytesOf = (text: string): number => Buffer.from(text, "utf8").byteLength;
const MARKER_BYTES = bytesOf(TOOL_OUTPUT_TRUNCATION_MARKER);
const END_BUDGET_BYTES = Math.floor((MAX_TOOL_OUTPUT_BYTES - MARKER_BYTES) / 2);

describe("bounding tool output", () => {
  it("returns output at exactly the budget unchanged and without a marker", () => {
    const content = "a".repeat(MAX_TOOL_OUTPUT_BYTES);

    expect(boundToolOutput(content)).toEqual({ content, truncated: false });
    expect(content).not.toContain(TOOL_OUTPUT_TRUNCATION_MARKER);
    expect(bytesOf(content)).toBe(MAX_TOOL_OUTPUT_BYTES);

    const multibyte = `${"a".repeat(MAX_TOOL_OUTPUT_BYTES - 2)}é`;
    expect(boundToolOutput(multibyte)).toEqual({ content: multibyte, truncated: false });
  });

  it("keeps a head and a tail around the marker, exactly at the budget", () => {
    // The marker is 26 bytes, so ADR 0001 §3 gives each end (40,960 - 26) / 2 = 20,467 bytes.
    const content = "a".repeat(20_467) + "OMITTED".repeat(100) + "z".repeat(20_467);

    const bounded = boundToolOutput(content);

    expect(bounded).toEqual({
      content: "a".repeat(20_467) + TOOL_OUTPUT_TRUNCATION_MARKER + "z".repeat(20_467),
      truncated: true,
    });
    expect(bytesOf(bounded.content)).toBe(MAX_TOOL_OUTPUT_BYTES);
    expect(TOOL_OUTPUT_TRUNCATION_MARKER).toBe("\n[...output truncated...]\n");
    expect(bytesOf(TOOL_OUTPUT_TRUNCATION_MARKER)).toBe(26);
  });

  it("moves a head cut that falls inside a two-byte character back to its start", () => {
    // The head budget ends on the second byte of "é", so the whole character is dropped.
    const content = `${"a".repeat(20_466)}é${"b".repeat(50_000)}`;

    const bounded = boundToolOutput(content);

    expect(bounded).toEqual({
      content: "a".repeat(20_466) + TOOL_OUTPUT_TRUNCATION_MARKER + "b".repeat(20_467),
      truncated: true,
    });
    expect(bytesOf(bounded.content)).toBe(MAX_TOOL_OUTPUT_BYTES - 1);
  });

  it("moves a head cut that falls inside a four-byte character back to its start", () => {
    // "😀" is a surrogate pair in UTF-16, and four bytes in UTF-8.
    const content = `${"a".repeat(20_466)}😀${"b".repeat(50_000)}`;

    const bounded = boundToolOutput(content);

    expect(bounded).toEqual({
      content: "a".repeat(20_466) + TOOL_OUTPUT_TRUNCATION_MARKER + "b".repeat(20_467),
      truncated: true,
    });
    expect(bytesOf(bounded.content)).toBe(MAX_TOOL_OUTPUT_BYTES - 1);
  });

  it("moves a tail cut that falls inside a two-byte character forward to its start", () => {
    // The tail budget starts on the second byte of "é", so the whole character is dropped.
    const content = `${"x".repeat(30_000)}é${"y".repeat(20_466)}`;

    const bounded = boundToolOutput(content);

    expect(bounded).toEqual({
      content: "x".repeat(20_467) + TOOL_OUTPUT_TRUNCATION_MARKER + "y".repeat(20_466),
      truncated: true,
    });
    expect(bytesOf(bounded.content)).toBe(MAX_TOOL_OUTPUT_BYTES - 1);
  });

  it("keeps a multi-byte character that ends exactly at the tail budget", () => {
    // The rope ends in a multi-byte character at the exact byte boundary; Bun 1.3.14's
    // TextEncoder.encode used to drop it, so this also guards the Buffer-based measurement.
    const content = `${"a".repeat(40_959)}é`;

    const bounded = boundToolOutput(content);

    expect(bounded).toEqual({
      content: `${"a".repeat(20_467)}${TOOL_OUTPUT_TRUNCATION_MARKER}${"a".repeat(20_465)}é`,
      truncated: true,
    });
    expect(bytesOf(bounded.content)).toBe(MAX_TOOL_OUTPUT_BYTES);
  });

  it("counts long runs of lone surrogates by the bytes they encode to", () => {
    // Each lone surrogate encodes as the three-byte U+FFFD, so 20,000 of them are 60,000 bytes.
    // The pinned Bun 1.3.14 reports 40,000 through Buffer.byteLength, which let the old check
    // pass; newer Bun versions report the full count, so CI is what keeps this regression covered.
    const replacementCount = Math.floor(END_BUDGET_BYTES / 3);
    const replacement = "\uFFFD".repeat(replacementCount);
    const content = "\ud800".repeat(20_000);

    const bounded = boundToolOutput(content);

    expect(bounded).toEqual({
      content: `${replacement}${TOOL_OUTPUT_TRUNCATION_MARKER}${replacement}`,
      truncated: true,
    });
    expect(bytesOf(bounded.content)).toBe(replacementCount * 3 * 2 + MARKER_BYTES);
  });

  it("drops one four-byte character at each cut, landing six bytes under the budget", () => {
    // A four-byte character can leave three bytes inside an end budget; moving the cut to its
    // start drops those three bytes, so both ends together lose six.
    const droppedPerEnd = bytesOf("😀") - 1;
    const textLength = END_BUDGET_BYTES - droppedPerEnd;
    const head = `${"a".repeat(textLength)}😀`;
    const tail = `😀${"c".repeat(textLength)}`;
    // Three end budgets leave one for each end and a middle between the two cuts.
    const content = `${head}${"b".repeat(3 * END_BUDGET_BYTES - bytesOf(head) - bytesOf(tail))}${tail}`;

    const bounded = boundToolOutput(content);

    expect(bounded).toEqual({
      content: `${"a".repeat(textLength)}${TOOL_OUTPUT_TRUNCATION_MARKER}${"c".repeat(textLength)}`,
      truncated: true,
    });
    expect(bytesOf(bounded.content)).toBe(MAX_TOOL_OUTPUT_BYTES - 2 * droppedPerEnd);
  });
});
