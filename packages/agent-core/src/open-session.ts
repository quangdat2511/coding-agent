import { type ConfigProblem, findConfigProblem, issueSessionId } from "./config-validation.ts";
import type { AgentSession, OpenSessionConfig, OpenSessionResult } from "./session.ts";
import type { ReadyState } from "./state.ts";

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
    usage: { inputTokens: 0, outputTokens: 0 },
    counters: { modelTurns: 0, toolCalls: 0, consecutiveRecoverableFailures: 0 },
    activeDurationMs: 0,
    workspaceChanged: false,
    partialChangesPossible: false,
    lastSequence: 0,
  };

  const notImplemented = (operation: keyof AgentSession) =>
    new Error(`AgentSession.${operation} is not implemented yet`);

  const session: AgentSession = {
    dispatch: async () => {
      throw notImplemented("dispatch");
    },
    snapshot: () => state,
    events: () => {
      throw notImplemented("events");
    },
    result: async () => {
      throw notImplemented("result");
    },
  };

  return { ok: true, session };
}
