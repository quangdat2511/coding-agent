import type { TranscriptWording } from "../../src/index.ts";

export function fakeWording(): TranscriptWording {
  return {
    closingToolResult: (call, closing) =>
      closing.outcome === "skipped"
        ? `${call.name} not run: ${closing.reason}`
        : `${call.name} stopped without a result`,
    outcomeNote: (result) =>
      `task ended: ${result.outcome === "failed" ? result.failure.code : result.outcome}`,
  };
}
