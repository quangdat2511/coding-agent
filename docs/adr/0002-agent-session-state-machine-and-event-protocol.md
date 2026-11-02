# Agent Session State Machine and Event Protocol

Status: accepted

Date: 2026-09-12

## Context

[Define the agent-runtime state machine and event protocol](https://datn-fit-hcmus.atlassian.net/browse/CDA-16)
must make one in-memory Coding Task observable and controllable without leaking provider behavior
or hidden control flow into the TUI, headless runner, or tests. The design must compose model
streaming, sequential Tool Calls, Approval, Verification, cancellation, and bounded execution.

Agent Core is a deep module: callers use one command seam, one snapshot, one ordered Session Event
stream, and one terminal Agent Result. Provider-specific streaming and message conversion remain
inside `@coding-agent/ai`; presentation and exit-code policy remain outside Agent Core.

## Decision

### 1. Authority and public interface

Agent State is the authoritative current snapshot. A deterministic reducer is the only code that
commits state transitions. Session Events are immutable observations emitted after a transition
commits; they are not commands and do not form an event-sourcing or replay contract.

This ADR standardizes the Approval state as `awaiting_approval`, replacing the working name
`PENDING_APPROVAL` in the earlier
[tool-contract and safety decision](./0001-tool-contracts-and-safety-policy.md). This is a
terminology refinement, not a change to Approval behavior.

The Agent Session interface has four operations:

```typescript
interface AgentSession {
  dispatch(command: SessionCommand): Promise<CommandResult>;
  snapshot(): AgentState;
  events(afterSequence?: number): AsyncIterable<SessionEvent>;
  result(): Promise<AgentResult>;
}

type SessionCommand =
  | { type: "start"; task: CodingTask }
  | {
      type: "resolve_approval";
      approvalId: string;
      decision: "allow" | "deny";
      reason?: string;
    }
  | { type: "cancel"; reason?: string };

type CommandResult =
  | { accepted: true; sequence: number }
  | {
      accepted: false;
      code: "INVALID_STATE" | "ALREADY_STARTED" | "STALE_APPROVAL" | "ALREADY_SETTLED";
      message: string;
    };
```

The public types above and the terminal result below depend on these minimum shapes:

```typescript
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

interface CodingTask {
  objective: string;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

interface AgentFailure {
  code: AgentFailureCode;
  message: string;
  details?: Readonly<Record<string, JsonValue>>;
}

interface VerificationSummary {
  outcome: "succeeded" | "continue" | "failed" | "cancelled";
  evidence: readonly Readonly<Record<string, JsonValue>>[];
}
```

`repoRoot` is construction configuration rather than part of the Coding Task and is validated
before the session reaches `ready`. The exact exported type organization belongs to
[Define package APIs and dependency direction](https://datn-fit-hcmus.atlassian.net/browse/CDA-20),
while the evidence records and feedback representation belong to
[Define MVP context, planning, verification, and session memory](https://datn-fit-hcmus.atlassian.net/browse/CDA-23).
The shapes above are the minimum semantics those decisions must preserve.

All commands pass through one serialized internal queue. `start` is accepted once. An Approval
command must name the currently pending Approval. A repeated cancellation while cancelling or
cancelled is an accepted no-op and returns the current sequence. Cancellation after success or
failure returns `ALREADY_SETTLED`.

Session construction validates required adapters, tools, policies, and limits before producing a
`ready` session. Invalid construction returns a configuration error and creates no Agent Session,
state transition, or Session Event.

### 2. Agent State

Agent State is a readonly, phase-specific tagged union. Common data includes:

- `sessionId`, the optional Coding Task, canonical transcript, usage totals, and counters;
- stable locally generated IDs for Model Turns, Assistant Messages, Tool Calls, Approvals, and
  Verification runs;
- active execution duration, workspace-mutation indicators, and `lastSequence`;
- only the data valid for the current phase, such as an in-progress Assistant Message, queued Tool
  Calls, pending Approval, active Tool Call, Verification run, or terminal Agent Result.

The complete event log is owned separately by the Agent Session and is not copied into snapshots.
Impossible combinations, such as a pending Approval while `streaming_model`, cannot be represented.

The explicit states are:

```text
ready
streaming_model
awaiting_approval
executing_tool
verifying
cancelling
succeeded
failed
cancelled
```

The transition graph is:

```text
ready
  -> streaming_model

streaming_model
  -> awaiting_approval       first queued call requires Approval under the interactive policy
  -> executing_tool          first queued call starts execution, or resolves with queued calls remaining
  -> streaming_model         sole queued call resolves during preflight
  -> verifying               Candidate Completion
  -> failed                  fatal model/protocol/internal failure or exhausted limit

awaiting_approval
  -> executing_tool          allow, or deny with queued calls remaining
  -> streaming_model         deny, then no queued call remains

executing_tool
  -> awaiting_approval       next queued call requires Approval during preflight
  -> executing_tool          current call completes, then next queued call advances
  -> streaming_model         current call completes, then no queued call remains

verifying
  -> succeeded               Verification policy returns succeed
  -> streaming_model         Verification policy returns continue with feedback
  -> failed                  Verification policy returns fail

any nonterminal state
  -> cancelling              accepted cancellation
  -> failed                  fatal failure

cancelling
  -> cancelled               active effect and queued work quiesce
  -> failed                  cancellation grace expires
```

Between consecutive Tool Calls in a batch, the session carries the remaining queue and advances
`toolCall` to the next call upon completing the prior one, so preflight for the upcoming call executes
while the snapshot reflects `executing_tool` rather than dropping back to `streaming_model`.
Consequently, a multi-call batch where all calls fail preflight still passes through `executing_tool`
between calls, whereas a sole queued call resolving during preflight stays in `streaming_model`.
Furthermore, subsequent mutating calls are already in `executing_tool` during their preflight before
transitioning to `awaiting_approval`.

Being in `executing_tool` does not mean the tool has executed or even started running:
`tool_execution_started` remains the execution boundary. A Tool Call without that event is unstarted;
cancelling before that boundary records `skipped` rather than `cancelled`. The `awaiting_approval`
transition occurs once preflight determines an interactive decision is required, and completing or
denying a call replaces the active phase data with the next queued call without reusing any prior
Approval.

Terminal states have no outgoing transitions. While preflight performs asynchronous preparation
(ADR 0004) inside `streaming_model` or `executing_tool` rather than as an instantaneous step,
Schema Validation, path checks, Approval Policy evaluation, and Tool Result recording are internal
steps within those phases, not extra states.

### 3. Model Turns, Tool Calls, and transcript commitment

A Model Turn is one model request and streamed response plus resolution of every Tool Call produced
by that response. The next model request begins the next Model Turn.

Agent Core asks providers to disable parallel Tool Calls when the provider supports that option,
but it accepts a batch defensively. It queues the complete calls in model order and resolves them
sequentially. The next Model Turn starts only after every queued call has a terminal outcome.

Each Tool Call passes through this zero-side-effect preflight before execution:

1. resolve the registered tool;
2. assemble and parse complete arguments;
3. perform Schema Validation;
4. perform repository, path, working-directory, and other deterministic policy checks;
5. classify mutation and evaluate the Approval Policy;
6. obtain Approval when required;
7. execute the tool.

Unknown tools, malformed or invalid arguments, policy violations, Approval denial, and tool
failures become structured error Tool Results. They are appended to the transcript so the model can
self-correct. They do not fail the Agent Session unless the consecutive-recoverable-failure limit
is exhausted. Remaining calls in the same batch continue in order.

A denial or recoverable Tool Result never skips later calls. `tool_execution_started` is the
execution boundary: a Tool Call without that event is unstarted. `cancelled` is reserved for a call
that crossed that boundary and was aborted; `skipped` is reserved for an unstarted Tool Call when
the session begins terminating, such as after cancellation, a fatal failure, or an exhausted limit.
A skipped call records the session-ending reason and has no Tool Result because no later Model Turn
will occur.

An in-progress Assistant Message lives outside the canonical transcript. Renderable text and
explicitly displayable reasoning update that partial message. Opaque provider reasoning is retained
for provider round-tripping but is not published as displayable content. Tool Call argument
fragments remain internal until complete; invalid partial JSON is never exposed as a Tool Call.

A successfully completed Assistant Message is appended to the canonical transcript. Failed or
cancelled partial output remains available for diagnostics but is never replayed to a provider.
Each Tool Result is committed immediately to the canonical transcript; the AI adapter batches or
reorders canonical result blocks when a provider requires a stricter wire representation.

Approval and Verification records stay in Agent State and the Session Event log. They enter model
context only when represented as a Tool Result or as explicit Verification feedback.

### 4. Candidate Completion, Verification, and stop conditions

A successfully completed model response containing no client-executed Tool Calls is a Candidate
Completion, not immediate success. Agent Core invokes an injected Verification/completion policy.
The Coding Agent composition root supplies this policy; the downstream Verification design owns
its exact checks, evidence, and feedback representation.

The policy returns exactly one decision:

- `succeed`: enter `succeeded`;
- `continue`: append explicit feedback and begin another Model Turn;
- `fail`: enter `failed` with `VERIFICATION_FAILED`.

Agent Core enforces injected limits for:

- maximum Model Turns;
- maximum Tool Calls;
- maximum active execution duration; and
- maximum consecutive recoverable Tool Call failures.

The earlier idea of "non-progress turns" is rejected because Agent Core cannot infer semantic
progress deterministically. Consecutive recoverable failures are measurable: the counter increments
for each error Tool Result and resets after a successful Tool Result.

Verification `continue` does not increment the recoverable-failure counter. It always starts a new
Model Turn, so `maxModelTurns` and maximum active execution duration already bound repeated
Candidate Completion and Verification cycles. A separate `maxVerificationAttempts` limit is
deliberately excluded from the MVP as redundant configuration.

Active execution time includes model streaming, Tool Call execution, and Verification. It excludes
`ready` and human time in `awaiting_approval`. Cancellation uses its own injected grace period.
Limits are checked before launching each effect; active-duration exhaustion also aborts an in-flight
effect. A breached limit emits `runtime_limit_reached` and settles with `LIMIT_EXCEEDED`. Concrete
defaults belong to Coding Agent configuration.

The terminal failure codes are:

```typescript
type AgentFailureCode =
  | "MODEL_FAILURE"
  | "MODEL_PROTOCOL_ERROR"
  | "LIMIT_EXCEEDED"
  | "VERIFICATION_FAILED"
  | "CANCELLATION_TIMEOUT"
  | "INTERNAL_ERROR";
```

`MODEL_FAILURE` covers request, stream, content-filter, and incomplete-generation failures while
preserving phase and normalized provider reason as serializable details. `MODEL_PROTOCOL_ERROR`
covers malformed provider event sequences or unusable final messages. Tool errors remain Tool
Results rather than terminal Agent failures. No automatic retry, steering, prompt queue, pause,
resume, or recovery exists in this MVP.

Public failures contain a stable code, human-readable message, and serializable details. Raw
JavaScript `Error` values and mutable references never enter Agent State, Session Events, or Agent
Result.

Every terminal state contains the same Agent Result published by `session_settled` and returned by
`result()`:

```typescript
interface AgentResultBase {
  finalMessage?: AssistantMessage;
  usage: UsageTotals;
  verification?: VerificationSummary;
  workspaceChanged: boolean;
  partialChangesPossible: boolean;
  lastSequence: number;
}

type AgentResult =
  | (AgentResultBase & {
      outcome: "succeeded";
      finalMessage: AssistantMessage;
      verification: VerificationSummary;
    })
  | (AgentResultBase & {
      outcome: "failed";
      failure: AgentFailure;
    })
  | (AgentResultBase & {
      outcome: "cancelled";
      cancellation: { reason?: string };
    });
```

The full transcript and event log remain available through Agent Session observation and are not
duplicated in Agent Result. Coding Agent maps this provider-neutral result to presentation and
process exit behavior.

### 5. Cancellation and workspace mutation

An accepted cancellation enters `cancelling` immediately, schedules no new work, and signals the
active model, tool, or Verification adapter through its `AbortSignal`.

- With no active effect, the session quiesces synchronously.
- A pending Approval resolves as cancelled with `decidedBy: "user"`, because the accepted `cancel`
  command is the user's decision to terminate the session.
- The Tool Call associated with that pending Approval has not emitted `tool_execution_started`, so
  it receives a skipped outcome, not a cancelled outcome, and has no Tool Result.
- An executing Tool Call receives a cancelled outcome; any later queued, unstarted Tool Calls
  receive skipped outcomes in model order.
- A partial Assistant Message and its Model Turn complete with cancelled outcomes.
- An active Verification run completes with a cancelled outcome.
- Provider-side computation or billing may continue when that provider lacks native cancellation;
  this capability difference is preserved as diagnostic metadata.

The session enters `cancelled` only after active work quiesces. If an adapter ignores cancellation
beyond the grace period, the session enters `failed` with `CANCELLATION_TIMEOUT`; it never claims a
safe cancellation while an effect may still be running.

Agent State and Agent Result expose `workspaceChanged` and `partialChangesPossible`:

- pre-execution rejection changes neither value;
- beginning a mutating Tool Call sets `workspaceChanged` conservatively;
- failure or cancellation of a mutating Tool Call sets `partialChangesPossible`;
- terminal failure or cancellation after any mutation began sets `partialChangesPossible`;
- a successful session may still report `partialChangesPossible` if an earlier non-transactional
  mutation failed before the model recovered.

These rules reflect the accepted tool contract: `write` and `edit` protect their target files, but
parent directories may remain, while `bash` is explicitly non-transactional.

### 6. Session Event protocol

Every Session Event has this envelope:

```typescript
interface SessionEventEnvelope<TType extends string, TData> {
  readonly sessionId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: TType;
  readonly data: Readonly<TData>;
}
```

`sequence` starts at one and is the sole ordering authority. `occurredAt` comes from an injected
wall clock and is informational. Durations and deadlines use an injected monotonic clock. All IDs
come from an injected ID generator so tests can be deterministic. Provider-issued IDs are optional
metadata, never primary correlation keys.

The closed MVP event union is:

```text
Session
  session_started
  cancellation_requested
  runtime_limit_reached
  session_settled

Model Turn
  model_turn_started
  assistant_message_started
  assistant_content_delta
  assistant_message_completed
  model_turn_completed
  candidate_completion_detected

Tool Call
  tool_call_queued
  approval_requested
  approval_resolved
  tool_execution_started
  tool_execution_progress
  tool_call_completed

Verification
  verification_started
  verification_progress
  verification_completed
```

Payloads contain the minimum immutable semantic data:

| Event | Required payload |
| --- | --- |
| `session_started` | Coding Task |
| `model_turn_started` | Model Turn ID/index and model identity |
| `assistant_message_started` | Model Turn and Assistant Message IDs |
| `assistant_content_delta` | Message/block IDs, displayable content kind, and delta |
| `assistant_message_completed` | Message ID, `completed \| failed \| cancelled`, final or partial message, optional failure |
| `tool_call_queued` | Model Turn ID, queue index, normalized Tool Call |
| `approval_requested` | Approval ID, Tool Call ID, mutation summary, policy |
| `approval_resolved` | IDs, `allowed \| denied \| auto_approved \| cancelled`, `decidedBy: "user" \| "policy"`, optional reason |
| `tool_execution_started` | Tool Call ID and start metadata |
| `tool_execution_progress` | Tool Call ID and bounded progress update |
| `tool_call_completed` | Tool Call ID, `succeeded \| failed \| denied \| cancelled \| skipped`, optional Tool Result |
| `candidate_completion_detected` | Model Turn and Assistant Message IDs |
| `model_turn_completed` | Model Turn ID, `completed \| failed \| cancelled`, usage, optional failure |
| `verification_started` | Verification ID and Candidate Completion reference |
| `verification_progress` | Verification ID and bounded evidence/progress update |
| `verification_completed` | Verification ID, `succeeded \| continue \| failed \| cancelled`, evidence, optional feedback |
| `cancellation_requested` | reason and state from which cancellation was requested |
| `runtime_limit_reached` | limit kind, configured limit, and observed value |
| `session_settled` | Agent Result |

A generic `state_changed` event, provider wire events, and consumer-specific TUI events are
deliberately excluded. State transitions commit before their Session Events are appended, so an
observer handling an event always sees a snapshot at least as new as that event.

Lifecycle invariants are strict:

- `session_started` is the first event;
- every started Model Turn, Assistant Message, Tool Call, Approval, and Verification run receives
  exactly one completion or resolution event, including on failure and cancellation;
- content deltas and progress occur only between their corresponding start and completion events;
- a Model Turn completes only after its Assistant Message and all queued Tool Calls complete;
- `session_settled` occurs exactly once, carries the same Agent Result returned by `result()`, and
  is always the final event;
- Agent State is terminal before `session_settled` is published, and `result()` resolves only after
  that event has been appended.

For automatically approved mutating Tool Calls, Agent Core emits adjacent `approval_requested` and
`approval_resolved` events with `auto_approved` and `decidedBy: "policy"`, without entering
`awaiting_approval`. Read-only Tool Calls emit no Approval events.

### 7. Observation and retention

The producer never awaits consumers. Session Events are appended to Agent Core-owned queues and
the bounded session's complete in-memory event log before subscribers are notified. Consumer
exceptions terminate only that consumer and cannot fail the Coding Task.

`events()` defaults to replaying from sequence zero and then following live events. A consumer can
read a snapshot and call `events(snapshot.lastSequence)`; Agent Core atomically replays events after
that sequence and attaches the live stream, preventing gaps between snapshot and subscription.

The protocol has no per-event schema version. Package versioning and exhaustive TypeScript unions
are the compatibility contract. A schema version becomes necessary only if Session Events later
cross a process boundary or become persistent data.

## Consequences

- TUI, headless evaluation, and tests consume the same ordered protocol without knowing provider
  behavior or reaching into Agent Core implementation.
- Agent Core has one small external seam while retaining internal adapters for model streaming,
  tools, Approval, Verification, clocks, and IDs.
- Deterministic sequential execution and strict lifecycle pairing make cancellation, audit, and
  tests tractable at MVP scale.
- The full event log and renderable deltas consume memory, but the single-task runtime and enforced
  limits bound that cost.
- Persistent sessions, replay recovery, remote operation, concurrent tools, steering, retries,
  and cross-process protocol compatibility require later decisions rather than accidental growth
  of this interface.
