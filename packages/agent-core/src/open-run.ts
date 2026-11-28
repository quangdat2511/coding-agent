import { createAgentRun } from "./agent-run.ts";
import { copyTranscript } from "./carried-transcript.ts";
import { type ConfigProblem, findConfigProblem, issueRunId } from "./config-validation.ts";
import type { OpenRunConfig, OpenRunResult } from "./run.ts";
import type { ReadyState } from "./state.ts";
import { noUsage } from "./usage.ts";

const refuse = (problem: ConfigProblem): OpenRunResult => ({
  ok: false,
  code: "INVALID_CONFIGURATION",
  ...problem,
});

export function openAgentRun(config: OpenRunConfig): OpenRunResult {
  const problem = findConfigProblem(config);
  if (problem) return refuse(problem);

  const transcript = copyTranscript(config.transcript);
  if (!Array.isArray(transcript)) return refuse(transcript);

  const runId = issueRunId(config.ids);
  if (typeof runId !== "string") return refuse(runId);

  const state: ReadyState = {
    phase: "ready",
    runId,
    carriedMessages: transcript.length,
    transcript,
    usage: noUsage,
    counters: { modelTurns: 0, toolCalls: 0, consecutiveRecoverableFailures: 0 },
    activeDurationMs: 0,
    workspaceChanged: false,
    partialChangesPossible: false,
    lastSequence: 0,
  };

  return { ok: true, run: createAgentRun(config, state) };
}
