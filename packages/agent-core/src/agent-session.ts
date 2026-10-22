import type { AssistantMessage, ToolDeclaration } from "@coding-agent/ai";
import { createEventLog } from "./event-log.ts";
import type { SessionEvent, SessionEventType } from "./events.ts";
import { messageOf } from "./guards.ts";
import { readModelResponse } from "./model-response.ts";
import type { AgentFailure, AgentResult, UsageTotals } from "./result.ts";
import type { AgentSession, CommandResult, OpenSessionConfig, SessionCommand } from "./session.ts";
import type {
  AgentState,
  AssistantMessageDraft,
  AssistantMessageRef,
  ModelTurnRef,
  ReadyState,
  StreamingModelState,
} from "./state.ts";
import type { CodingTask } from "./task.ts";
import { addUsage, usageOf } from "./usage.ts";
import type { VerificationDecision } from "./verification.ts";

type Refusal = Extract<CommandResult, { accepted: false }>;

const refuse = (code: Refusal["code"], message: string): Refusal => ({
  accepted: false,
  code,
  message,
});

type EventDraft = {
  [T in SessionEventType]: Pick<Extract<SessionEvent, { type: T }>, "type" | "data">;
}[SessionEventType];

type StateWithoutPhase = Omit<ReadyState, "phase">;

type SessionOutcomeFields =
  | "usage"
  | "workspaceChanged"
  | "partialChangesPossible"
  | "lastSequence";

type Settlement<R = AgentResult> = R extends AgentResult ? Omit<R, SessionOutcomeFields> : never;

interface Candidate extends AssistantMessageRef {
  readonly message: AssistantMessage;
}

function withoutPhase(state: AgentState): StateWithoutPhase {
  return {
    sessionId: state.sessionId,
    ...(state.task === undefined ? {} : { task: state.task }),
    transcript: state.transcript,
    usage: state.usage,
    counters: state.counters,
    activeDurationMs: state.activeDurationMs,
    workspaceChanged: state.workspaceChanged,
    partialChangesPossible: state.partialChangesPossible,
    lastSequence: state.lastSequence,
  };
}

export function createAgentSession(config: OpenSessionConfig, initial: ReadyState): AgentSession {
  const log = createEventLog();
  let state: AgentState = initial;
  let queueTail: Promise<unknown> = Promise.resolve();
  const settled = Promise.withResolvers<AgentResult>();
  const abortEffects = new AbortController();
  const model = structuredClone(config.model.identity);
  const tools: readonly ToolDeclaration[] = config.tools
    .list()
    .map(({ name, description, parameters }) => ({ name, description, parameters }));

  function commit(next: AgentState, event: EventDraft): number {
    const occurredAt = config.clock.now();
    const sequence = log.lastSequence + 1;
    state = { ...next, lastSequence: sequence };
    log.append({ sessionId: state.sessionId, sequence, occurredAt, ...event });
    return sequence;
  }

  function terminal(result: AgentResult): AgentState {
    switch (result.outcome) {
      case "succeeded":
        return { ...withoutPhase(state), phase: "succeeded", result };
      case "failed":
        return { ...withoutPhase(state), phase: "failed", result };
      case "cancelled":
        return { ...withoutPhase(state), phase: "cancelled", result };
    }
  }

  function settle(settlement: Settlement): "settled" {
    const result: AgentResult = {
      ...settlement,
      usage: state.usage,
      workspaceChanged: state.workspaceChanged,
      partialChangesPossible: state.partialChangesPossible,
      lastSequence: log.lastSequence + 1,
    };
    commit(terminal(result), { type: "session_settled", data: { result } });
    log.close();
    settled.resolve(result);
    return "settled";
  }

  const fail = (failure: AgentFailure) => settle({ outcome: "failed", failure });

  function streaming(
    modelTurn: ModelTurnRef,
    assistantMessage: AssistantMessageDraft,
  ): StreamingModelState {
    return { ...withoutPhase(state), phase: "streaming_model", modelTurn, assistantMessage };
  }

  function partialMessage(draft: AssistantMessageDraft, failure: AgentFailure): AssistantMessage {
    return {
      role: "assistant",
      content: draft.blocks.map(({ text }) => ({ type: "text", text })),
      model: model.id,
      finishReason: { reason: "error", rawReason: failure.code },
    };
  }

  async function runModelTurn(): Promise<Candidate | "settled"> {
    const modelTurn: ModelTurnRef = {
      modelTurnId: config.ids.next("model_turn"),
      index: state.counters.modelTurns,
    };
    const { modelTurnId } = modelTurn;
    const messageId = config.ids.next("assistant_message");
    let draft: AssistantMessageDraft = { messageId, blocks: [] };

    commit(
      {
        ...streaming(modelTurn, draft),
        counters: { ...state.counters, modelTurns: state.counters.modelTurns + 1 },
      },
      { type: "model_turn_started", data: { ...modelTurn, model } },
    );
    commit(streaming(modelTurn, draft), {
      type: "assistant_message_started",
      data: { modelTurnId, messageId },
    });

    const response = await readModelResponse(
      () =>
        config.model.stream(
          {
            systemPrompt: config.systemPrompt,
            messages: state.transcript.map((message) => structuredClone(message)),
            tools,
          },
          { signal: abortEffects.signal, parallelToolCalls: false },
        ),
      (blockIndex, delta) => {
        const blocks = draft.blocks.slice();
        const block = blocks[blockIndex];
        blocks[blockIndex] = { kind: "text", text: (block?.text ?? "") + delta };
        draft = { messageId, blocks };
        commit(streaming(modelTurn, draft), {
          type: "assistant_content_delta",
          data: { messageId, blockIndex, kind: "text", delta },
        });
      },
    );

    const completeTurn = (usage: UsageTotals, failure?: AgentFailure) =>
      commit(
        { ...streaming(modelTurn, draft), usage: addUsage(state.usage, usage) },
        {
          type: "model_turn_completed",
          data:
            failure === undefined
              ? { modelTurnId, outcome: "completed", usage }
              : { modelTurnId, outcome: "failed", usage, failure },
        },
      );

    if (!response.ok) {
      const { failure } = response;
      const message = response.message ?? partialMessage(draft, failure);
      commit(streaming(modelTurn, draft), {
        type: "assistant_message_completed",
        data: { messageId, outcome: "failed", message, failure },
      });
      completeTurn(usageOf(message), failure);
      return fail(failure);
    }

    const { message } = response;
    commit(
      { ...streaming(modelTurn, draft), transcript: [...state.transcript, message] },
      { type: "assistant_message_completed", data: { messageId, outcome: "completed", message } },
    );
    if (message.content.some((block) => block.type === "tool_call")) {
      const failure: AgentFailure = {
        code: "INTERNAL_ERROR",
        message: "Tool Calls are not implemented yet",
      };
      completeTurn(usageOf(message), failure);
      return fail(failure);
    }
    commit(streaming(modelTurn, draft), {
      type: "candidate_completion_detected",
      data: { modelTurnId, messageId },
    });
    completeTurn(usageOf(message));
    return { modelTurnId, messageId, message };
  }

  async function verifyCandidate({
    message,
    ...messageRef
  }: Candidate): Promise<"continue" | "settled"> {
    const verification = {
      verificationId: config.ids.next("verification"),
      candidate: messageRef,
    };
    const { verificationId } = verification;
    commit(
      { ...withoutPhase(state), phase: "verifying", verification },
      { type: "verification_started", data: verification },
    );

    let decision: VerificationDecision;
    try {
      decision = structuredClone(
        await config.verification.verify(
          structuredClone({
            transcript: state.transcript,
            finalMessage: message,
            workspaceChanged: state.workspaceChanged,
          }),
          { signal: abortEffects.signal, onProgress: () => {} },
        ),
      );
    } catch (error) {
      commit(state, {
        type: "verification_completed",
        data: { verificationId, outcome: "failed", evidence: [] },
      });
      return fail({
        code: "INTERNAL_ERROR",
        message: `the Verification Policy threw: ${messageOf(error)}`,
      });
    }

    const summary = { outcome: decision.outcome, evidence: decision.evidence };
    switch (decision.outcome) {
      case "continue": {
        const { feedback } = decision;
        commit(
          { ...state, transcript: [...state.transcript, feedback] },
          { type: "verification_completed", data: { verificationId, ...summary, feedback } },
        );
        return "continue";
      }
      case "succeeded":
        commit(state, { type: "verification_completed", data: { verificationId, ...summary } });
        return settle({ outcome: "succeeded", finalMessage: message, verification: summary });
      case "failed":
        commit(state, { type: "verification_completed", data: { verificationId, ...summary } });
        return settle({
          outcome: "failed",
          failure: { code: "VERIFICATION_FAILED", message: decision.message },
          finalMessage: message,
          verification: summary,
        });
    }
  }

  async function run(): Promise<void> {
    for (;;) {
      const candidate = await runModelTurn();
      if (candidate === "settled" || (await verifyCandidate(candidate)) === "settled") return;
    }
  }

  function start({ objective }: CodingTask): CommandResult {
    if (state.task !== undefined) {
      return refuse("ALREADY_STARTED", "the session has already started");
    }
    const task: CodingTask = { objective };
    const sequence = commit(
      { ...state, task, transcript: [{ role: "user", content: objective }] },
      { type: "session_started", data: { task } },
    );
    run().catch((error: unknown) => {
      fail({ code: "INTERNAL_ERROR", message: messageOf(error) });
    });
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
      const handled = queueTail.then(() => handle(command));
      queueTail = handled.catch(() => {});
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
