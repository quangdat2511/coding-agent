import type { Clock } from "./ports.ts";

// Tool Progress keeps only the end of a tool's output: the newest lines say what the tool is
// doing now, and the Tool Result carries the full bounded output when the call completes.
export const TOOL_PROGRESS_MAX_BYTES = 2_048;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Keep the last maxBytes UTF-8 bytes of text. A cut inside a character moves forward to the next
// character, so the kept text never starts with a broken one.
export function progressTail(text: string, maxBytes = TOOL_PROGRESS_MAX_BYTES): string {
  // Every UTF-16 code unit encodes to at least one byte, so the last maxBytes code units hold at
  // least maxBytes bytes. Encoding only them keeps the cost independent of the output's length.
  const window = text.length > maxBytes ? text.slice(-maxBytes) : text;
  const bytes = encoder.encode(window);
  if (bytes.byteLength <= maxBytes) return window;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
}

// At most one Tool Progress Session Event per Tool Call in this interval, so a chatty command
// cannot flood the event log or its observers.
export const TOOL_PROGRESS_INTERVAL_MS = 250;

export interface ProgressGate {
  report(output: string): void;
  /** Stop delivering. A held update is discarded: the Tool Result carries the final output. */
  close(): void;
}

// Delivers a tool's progress at a bounded size and rate. An update that arrives before the
// interval ends is held, and a newer one replaces it; the held update is delivered when the
// interval ends. An update equal to the last delivered or held one is dropped.
export function createProgressGate(
  clock: Pick<Clock, "monotonicMs" | "setTimer">,
  deliver: (output: string) => void,
): ProgressGate {
  let open = true;
  let lastDeliveredMs: number | undefined;
  let lastDelivered: string | undefined;
  let held: string | undefined;
  let cancelTimer: (() => void) | undefined;

  const send = (output: string) => {
    lastDeliveredMs = clock.monotonicMs();
    lastDelivered = output;
    deliver(output);
  };

  return {
    report(output) {
      if (!open) return;
      const tail = progressTail(output);
      if (tail === (held ?? lastDelivered)) return;
      const waitMs =
        lastDeliveredMs === undefined
          ? 0
          : lastDeliveredMs + TOOL_PROGRESS_INTERVAL_MS - clock.monotonicMs();
      if (waitMs <= 0 && held === undefined) {
        send(tail);
        return;
      }
      held = tail;
      cancelTimer ??= clock.setTimer(Math.max(0, waitMs), () => {
        cancelTimer = undefined;
        const next = held;
        held = undefined;
        if (open && next !== undefined && next !== lastDelivered) send(next);
      });
    },
    close() {
      open = false;
      held = undefined;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}
