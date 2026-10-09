import type { Clock } from "../../src/index.ts";

export interface ManualClock extends Clock {
  advance(ms: number): void;
}

export function manualClock(start = "2026-10-01T00:00:00.000Z"): ManualClock {
  const startMs = Date.parse(start);
  let elapsedMs = 0;

  return {
    now: () => new Date(startMs + elapsedMs).toISOString(),
    monotonicMs: () => elapsedMs,
    advance(ms) {
      elapsedMs += ms;
    },
  };
}
