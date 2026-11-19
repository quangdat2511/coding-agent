// Preloaded into the Coding Agent with `bun --preload`. It replaces src/clock-and-ids.ts with a
// clock that never moves and identifiers that count from 1 for each kind, so two replays of one
// recording log the same times and identifiers. Never import it from a test file: the plugin would
// apply to the test runner itself.
import { plugin } from "bun";

plugin({
  name: "fixed-clock-and-ids",
  setup(build) {
    build.onLoad({ filter: /[/\\]clock-and-ids\.ts$/ }, () => ({
      contents: `
        export const systemClock = {
          now: () => "2026-01-01T00:00:00.000Z",
          monotonicMs: () => 0,
          // Time never moves, so no timer ever comes due.
          setTimer: () => () => undefined,
        };
        const issued = new Map();
        export const randomIds = {
          next: (kind) => {
            const count = (issued.get(kind) ?? 0) + 1;
            issued.set(kind, count);
            return kind + "-" + count;
          },
        };
      `,
      loader: "ts",
    }));
  },
});
