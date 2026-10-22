import { createAgentSession } from "./agent-session.ts";
import { type ConfigProblem, findConfigProblem, issueSessionId } from "./config-validation.ts";
import type { OpenSessionConfig, OpenSessionResult } from "./session.ts";
import type { ReadyState } from "./state.ts";
import { noUsage } from "./usage.ts";

const refuse = (problem: ConfigProblem): OpenSessionResult => ({
  ok: false,
  code: "INVALID_CONFIGURATION",
  ...problem,
});

export function openAgentSession(config: OpenSessionConfig): OpenSessionResult {
  const problem = findConfigProblem(config);
  if (problem) return refuse(problem);

  const sessionId = issueSessionId(config.ids);
  if (typeof sessionId !== "string") return refuse(sessionId);

  const state: ReadyState = {
    phase: "ready",
    sessionId,
    transcript: [],
    usage: noUsage,
    counters: { modelTurns: 0, toolCalls: 0, consecutiveRecoverableFailures: 0 },
    activeDurationMs: 0,
    workspaceChanged: false,
    partialChangesPossible: false,
    lastSequence: 0,
  };

  return { ok: true, session: createAgentSession(config, state) };
}
