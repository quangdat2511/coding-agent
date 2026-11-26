import type { RunEvent, UsageTotals } from "@coding-agent/agent-core";

export type TurnCostResult =
  | { readonly known: true; readonly costUsd: number }
  | { readonly known: false };

/**
 * Evaluates the turn-cost rule on one Model Turn:
 * turnCost = cost.totalFromProvider ?? cost.total
 * A turn with tokens > 0 and no cost makes the accumulated cost unknown.
 * A turn with 0 tokens and no cost (noUsage) counts as a known $0.
 */
export function calculateTurnCost(usage: UsageTotals): TurnCostResult {
  const cost = usage.cost?.totalFromProvider ?? usage.cost?.total;
  if (cost !== undefined) {
    return { known: true, costUsd: cost };
  }

  const totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    (usage.cachedInputTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0) +
    (usage.reasoningTokens ?? 0);

  if (totalTokens > 0) {
    return { known: false };
  }

  return { known: true, costUsd: 0 };
}

/**
 * Accumulates cost across turns:
 * - If previous cost is undefined, it stays undefined.
 * - If the turn cost is unknown, accumulated cost turns undefined.
 * - Otherwise sums the turn cost to previous cost.
 */
export function accumulateTurnCost(
  previousCost: number | undefined,
  turnUsage: UsageTotals,
): number | undefined {
  if (previousCost === undefined) return undefined;
  const turn = calculateTurnCost(turnUsage);
  if (!turn.known) return undefined;
  return previousCost + turn.costUsd;
}

/**
 * Consumes an AsyncIterable of RunEvents, accumulating cost over model_turn_completed.
 */
export async function collectTurnCost(
  events: AsyncIterable<RunEvent>,
): Promise<number | undefined> {
  let accumulated: number | undefined = 0;
  for await (const event of events) {
    if (event.type === "model_turn_completed") {
      accumulated = accumulateTurnCost(accumulated, event.data.usage);
    }
  }
  return accumulated;
}
