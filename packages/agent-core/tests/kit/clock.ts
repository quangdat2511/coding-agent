import type { Clock } from "../../src/index.ts";

export interface ManualClock extends Clock {
  /** Move monotonic time forward, running each timer that falls due at its own due time. */
  advance(ms: number): void;
}

interface Timer {
  readonly dueMs: number;
  readonly order: number;
  readonly callback: () => void;
}

export function manualClock(start = "2026-10-01T00:00:00.000Z"): ManualClock {
  const startMs = Date.parse(start);
  let elapsedMs = 0;
  let created = 0;
  const timers = new Set<Timer>();

  const nextDue = (untilMs: number): Timer | undefined => {
    let next: Timer | undefined;
    for (const timer of timers) {
      if (timer.dueMs > untilMs) continue;
      if (
        !next ||
        timer.dueMs < next.dueMs ||
        (timer.dueMs === next.dueMs && timer.order < next.order)
      ) {
        next = timer;
      }
    }
    return next;
  };

  return {
    now: () => new Date(startMs + elapsedMs).toISOString(),
    monotonicMs: () => elapsedMs,
    setTimer(delayMs, callback) {
      const timer = { dueMs: elapsedMs + Math.max(0, delayMs), order: created++, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    advance(ms) {
      const untilMs = elapsedMs + ms;
      for (let timer = nextDue(untilMs); timer; timer = nextDue(untilMs)) {
        timers.delete(timer);
        elapsedMs = timer.dueMs;
        timer.callback();
      }
      elapsedMs = untilMs;
    },
  };
}
