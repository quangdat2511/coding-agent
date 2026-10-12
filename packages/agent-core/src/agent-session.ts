import { createEventLog } from "./event-log.ts";
import type { SessionEvent, SessionEventType } from "./events.ts";
import type { AgentFailure, AgentResult, FailedResult } from "./result.ts";
import type { AgentSession, CommandResult, OpenSessionConfig, SessionCommand } from "./session.ts";
import type { AgentState, ReadyState } from "./state.ts";
import type { CodingTask } from "./task.ts";

type Refusal = Extract<CommandResult, { accepted: false }>;

const refuse = (code: Refusal["code"], message: string): Refusal => ({
  accepted: false,
  code,
  message,
});

type EventDraft = {
  [T in SessionEventType]: Pick<Extract<SessionEvent, { type: T }>, "type" | "data">;
}[SessionEventType];

export function createAgentSession(config: OpenSessionConfig, initial: ReadyState): AgentSession {
  const log = createEventLog();
  let state: AgentState = initial;
  let commands: Promise<unknown> = Promise.resolve();
  const settled = Promise.withResolvers<AgentResult>();

  function commit(next: AgentState, event: EventDraft): number {
    const occurredAt = config.clock.now();
    const sequence = log.lastSequence + 1;
    state = { ...next, lastSequence: sequence };
    log.append({ sessionId: state.sessionId, sequence, occurredAt, ...event });
    return sequence;
  }

  function fail(failure: AgentFailure): void {
    const result: FailedResult = {
      outcome: "failed",
      failure,
      usage: state.usage,
      workspaceChanged: state.workspaceChanged,
      partialChangesPossible: state.partialChangesPossible,
      lastSequence: log.lastSequence + 1,
    };
    commit({ ...state, phase: "failed", result }, { type: "session_settled", data: { result } });
    log.close();
    settled.resolve(result);
  }

  function start({ objective }: CodingTask): CommandResult {
    if (state.task !== undefined) {
      return refuse("ALREADY_STARTED", "the session has already started");
    }
    const task: CodingTask = { objective };
    const sequence = commit({ ...state, task }, { type: "session_started", data: { task } });
    fail({ code: "INTERNAL_ERROR", message: "Model Turns are not implemented yet" });
    return { accepted: true, sequence };
  }

  function handle(command: SessionCommand): CommandResult {
    switch (command.type) {
      case "start":
        return start(command.task);
      case "resolve_approval":
        return refuse("INVALID_STATE", `no Approval is pending while ${state.phase}`);
      case "cancel":
        return state.phase === "succeeded" || state.phase === "failed"
          ? refuse("ALREADY_SETTLED", `the session has already ${state.phase}`)
          : refuse("INVALID_STATE", `cannot cancel a session in ${state.phase}`);
    }
  }

  return {
    dispatch(command) {
      const handled = commands.then(() => handle(command));
      commands = handled.catch(() => {});
      return handled;
    },
    snapshot: () => state,
    events(afterSequence = 0) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new RangeError(`afterSequence must be a non-negative integer, got ${afterSequence}`);
      }
      return log.follow(afterSequence);
    },
    result: () => settled.promise,
  };
}
