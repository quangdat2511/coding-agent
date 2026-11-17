import type { LimitKind } from "./events.ts";
import type { Clock, SessionLimits } from "./ports.ts";
import type { SessionCounters } from "./state.ts";

export interface LimitBreach {
  readonly kind: LimitKind;
  readonly limit: number;
  readonly observed: number;
}

export interface LimitGuard {
  resume(): void;
  pause(): void;
  elapsed(): number;
  remainingMs(): number;
  checkBeforeModelTurn(counters: SessionCounters): LimitBreach | undefined;
  checkBeforeToolExecution(counters: SessionCounters): LimitBreach | undefined;
  checkBeforeVerification(): LimitBreach | undefined;
  checkAfterToolResult(counters: SessionCounters): LimitBreach | undefined;
}

export function createLimitGuard(limits: SessionLimits, clock: Clock): LimitGuard {
  let activeSince: number | undefined;
  let accumulatedMs = 0;

  const elapsed = (): number =>
    accumulatedMs + (activeSince === undefined ? 0 : clock.monotonicMs() - activeSince);

  const durationBreach = (): LimitBreach | undefined => {
    const observed = elapsed();
    return observed >= limits.maxDurationMs
      ? { kind: "maxDurationMs", limit: limits.maxDurationMs, observed }
      : undefined;
  };

  return {
    resume() {
      if (activeSince === undefined) activeSince = clock.monotonicMs();
    },
    pause() {
      if (activeSince !== undefined) {
        const startedAt = activeSince;
        activeSince = undefined;
        try {
          accumulatedMs += clock.monotonicMs() - startedAt;
        } catch {
          // Keep settlement and snapshots usable if the injected clock has failed.
        }
      }
    },
    elapsed,
    remainingMs: () => Math.max(0, limits.maxDurationMs - elapsed()),
    checkBeforeModelTurn(counters) {
      if (counters.modelTurns >= limits.maxModelTurns) {
        return {
          kind: "maxModelTurns",
          limit: limits.maxModelTurns,
          observed: counters.modelTurns,
        };
      }
      return durationBreach();
    },
    checkBeforeToolExecution(counters) {
      if (counters.toolCalls >= limits.maxToolCalls) {
        return {
          kind: "maxToolCalls",
          limit: limits.maxToolCalls,
          observed: counters.toolCalls,
        };
      }
      return durationBreach();
    },
    checkBeforeVerification: durationBreach,
    checkAfterToolResult(counters) {
      return counters.consecutiveRecoverableFailures >= limits.maxConsecutiveRecoverableFailures
        ? {
            kind: "maxConsecutiveRecoverableFailures",
            limit: limits.maxConsecutiveRecoverableFailures,
            observed: counters.consecutiveRecoverableFailures,
          }
        : undefined;
    },
  };
}
