import type { Clock, IdSource } from "@coding-agent/agent-core";

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  monotonicMs: () => Math.floor(performance.now()),
  setTimer: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export const randomIds: IdSource = { next: (kind) => `${kind}-${crypto.randomUUID()}` };
