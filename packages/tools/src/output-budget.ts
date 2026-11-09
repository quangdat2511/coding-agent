import { Buffer } from "node:buffer";

// ADR 0001 §3 bounds a tool's content at 40 KiB of UTF-8, the truncation marker included, so
// noisy output cannot flood the context window. Every tool shares this budget, and the Verification
// Runner will use it too.
export const MAX_TOOL_OUTPUT_BYTES = 40_960;

// ADR 0001 §3's marker, counted against the budget.
export const TOOL_OUTPUT_TRUNCATION_MARKER = "\n[...output truncated...]\n";

// Bun 1.3.14, the version pinned in .bun-version, miscounts some long strings: TextEncoder.encode
// reports 40,960 bytes for "a".repeat(40_959) + "é" (with a trailing zero byte) instead of 40,961,
// and Buffer.byteLength reports 40,000 bytes for 20,000 lone surrogates whose U+FFFD replacements
// encode to 60,000. Encoding once with Buffer.from gives the real bytes for both the check and the
// cuts.
// ignoreBOM keeps a byte order mark that falls at a cut, as readTextFile keeps one at the start.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

const MARKER_BYTES = Buffer.from(TOOL_OUTPUT_TRUNCATION_MARKER, "utf8").byteLength;

export interface BoundedOutput {
  readonly content: string;
  readonly truncated: boolean;
}

// Output over the budget keeps both ends: the beginning names what ran and the end holds the final
// error. The budgets are measured in bytes, and each cut moves to the nearest code point boundary
// so a decoded half never starts or ends inside a multi-byte character.
export function boundToolOutput(content: string): BoundedOutput {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= MAX_TOOL_OUTPUT_BYTES) return { content, truncated: false };
  // ADR 0001 §3 splits what remains evenly: the 26-byte marker leaves 20,467 bytes for each end.
  const half = Math.floor((MAX_TOOL_OUTPUT_BYTES - MARKER_BYTES) / 2);
  const headEnd = codePointStartAtOrBefore(bytes, half);
  const tailStart = codePointStartAtOrAfter(bytes, bytes.byteLength - half);
  return {
    content:
      decoder.decode(bytes.subarray(0, headEnd)) +
      TOOL_OUTPUT_TRUNCATION_MARKER +
      decoder.decode(bytes.subarray(tailStart)),
    truncated: true,
  };
}

// A continuation byte (0b10xxxxxx) never starts a code point, so a cut inside one moves back to the
// lead byte that does.
function codePointStartAtOrBefore(bytes: Uint8Array, index: number): number {
  let start = index;
  while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start--;
  return start;
}

// The same rule forwards: a cut inside a code point moves to the lead byte that starts the next one.
function codePointStartAtOrAfter(bytes: Uint8Array, index: number): number {
  let start = index;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return start;
}
