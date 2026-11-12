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
// so a decoded half never starts or ends inside a multi-byte character. A caller that appends its
// own text, such as bash's status line, passes a smaller budget so the total stays within 40 KiB.
export function boundToolOutput(content: string, budget = MAX_TOOL_OUTPUT_BYTES): BoundedOutput {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= budget) return { content, truncated: false };
  return joinEnds(bytes, bytes, budget);
}

// ADR 0001 §3 splits what remains evenly: the 26-byte marker leaves 20,467 bytes for each end of
// the full budget.
const endBudget = (budget: number): number => Math.floor((budget - MARKER_BYTES) / 2);

// head starts where the output starts and tail ends where it ends; each holds at least one end's
// budget.
function joinEnds(head: Uint8Array, tail: Uint8Array, budget: number): BoundedOutput {
  const half = endBudget(budget);
  const headEnd = codePointStartAtOrBefore(head, half);
  const tailStart = codePointStartAtOrAfter(tail, tail.byteLength - half);
  return {
    content:
      decoder.decode(head.subarray(0, headEnd)) +
      TOOL_OUTPUT_TRUNCATION_MARKER +
      decoder.decode(tail.subarray(tailStart)),
    truncated: true,
  };
}

export interface OutputCollector {
  push(chunk: Uint8Array): void;
  /** Bound everything pushed so far, leaving reservedBytes of the budget for the caller's text. */
  finish(reservedBytes: number): BoundedOutput;
}

// Collects a child's output as it streams, holding at most the budget in memory: all of it while
// it fits, then only the first and last end budget's bytes. Bytes that are not UTF-8 decode to
// U+FFFD. finish gives the same content as boundToolOutput on the whole output.
export function createOutputCollector(): OutputCollector {
  const keep = endBudget(MAX_TOOL_OUTPUT_BYTES);
  // Every chunk while the output fits the budget; undefined once it has been cut.
  let whole: Uint8Array[] | undefined = [];
  let total = 0;
  // One byte past the head's budget shows whether the head cut falls inside a character.
  const head = new Uint8Array(keep + 1);
  // The last `keep` bytes, as a ring: `ringAt` is where the next byte goes.
  const ring = new Uint8Array(keep);
  let ringAt = 0;

  const toRing = (chunk: Uint8Array) => {
    const recent = chunk.byteLength > keep ? chunk.subarray(chunk.byteLength - keep) : chunk;
    const first = Math.min(recent.byteLength, keep - ringAt);
    ring.set(recent.subarray(0, first), ringAt);
    ring.set(recent.subarray(first), 0);
    ringAt = (ringAt + recent.byteLength) % keep;
  };

  return {
    push(chunk) {
      if (chunk.byteLength === 0) return;
      if (whole) {
        whole.push(chunk.slice());
        if (total + chunk.byteLength <= MAX_TOOL_OUTPUT_BYTES) {
          total += chunk.byteLength;
          return;
        }
        // The output no longer fits, so it will be cut: keep only its ends from here on.
        const all = Buffer.concat(whole);
        whole = undefined;
        head.set(all.subarray(0, keep + 1));
        toRing(all);
        return;
      }
      toRing(chunk);
    },
    finish(reservedBytes) {
      const budget = MAX_TOOL_OUTPUT_BYTES - reservedBytes;
      if (whole) {
        const bytes = Buffer.concat(whole);
        if (bytes.byteLength <= budget) return { content: decoder.decode(bytes), truncated: false };
        return joinEnds(bytes, bytes, budget);
      }
      const tail = Buffer.concat([ring.subarray(ringAt), ring.subarray(0, ringAt)]);
      return joinEnds(head, tail, budget);
    },
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
