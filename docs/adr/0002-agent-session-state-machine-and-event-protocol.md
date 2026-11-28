# Agent Run State Machine and Event Protocol

Status: accepted

Date: 2026-09-12

## Context

[Define the agent-runtime state machine and event protocol](https://datn-fit-hcmus.atlassian.net/browse/CDA-16)
must make one in-memory Coding Task observable and controllable without leaking provider behavior
or hidden control flow into the TUI, headless runner, or tests. The design must compose model
streaming, sequential Tool Calls, Approval, Verification, cancellation, and bounded execution.

Agent Core is a deep module: callers use one command seam, one snapshot, one ordered Run Event
stream, and one terminal Agent Result. Provider-specific streaming and message conversion remain
inside `@coding-agent/ai`; presentation and exit-code policy remain outside Agent Core.

## Decision

### 1. Authority and public interface

Agent State is the authoritative current snapshot. A deterministic reducer is the only code that
commits state transitions. Run Events are immutable observations emitted after a transition
commits; they are not commands and do not form an event-sourcing or replay contract.

This ADR standardizes the Approval state as `awaiting_approval`, replacing the working name
`PENDING_APPROVAL` in the earlier
[tool-contract and safety decision](./0001-tool-contracts-and-safety-policy.md). This is a
terminology refinement, not a change to Approval behavior.

The Agent Run interface has four operations:

```typescript
interface AgentRun {
  dispatch(command: RunCommand): Promise<CommandResult>;
  snapshot(): AgentState;
  events(afterSequence?: number): AsyncIterable<RunEvent>;
  result(): Promise<AgentResult>;
}

type RunCommand =
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
before the Agent Run reaches `ready`. The exact exported type organization belongs to
[Define package APIs and dependency direction](https://datn-fit-hcmus.atlassian.net/browse/CDA-20),
while the evidence records and feedback representation belong to
[Define MVP context, planning, verification, and session memory](https://datn-fit-hcmus.atlassian.net/browse/CDA-23).
The shapes above are the minimum semantics those decisions must preserve.

All commands pass through one serialized internal queue. `start` is accepted once. An Approval
command must name the currently pending Approval. A repeated cancellation while cancelling or
cancelled is an accepted no-op and returns the current sequence. Cancellation after success or
failure returns `ALREADY_SETTLED`.

Agent Run construction validates required adapters, tools, policies, and limits before producing a
`ready` Agent Run. Invalid construction returns a configuration error and creates no Agent Run,
state transition, or Run Event.

### 2. Agent State

Agent State is a readonly, phase-specific tagged union. Common data includes:

- `runId`, the optional Coding Task, canonical transcript, usage totals, and counters;
- stable locally generated IDs for Model Turns, Assistant Messages, Tool Calls, Approvals, and
  Verification runs;
- active execution duration, workspace-mutation indicators, and `lastSequence`;
- only the data valid for the current phase, such as an in-progress Assistant Message, queued Tool
  Calls, pending Approval, active Tool Call, Verification run, or terminal Agent Result.

The complete event log is owned separately by the Agent Run and is not copied into snapshots.
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

Between consecutive Tool Calls in a batch, the Agent Run carries the remaining queue and advances
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
failures become structured error Tool Results. Their model-facing messages are appended to the
transcript so the model can self-correct. These errors do not fail the Agent Run unless the
consecutive-recoverable-failure limit is exhausted. The rest of the batch continues in order.

A denial or recoverable Tool Result never skips later calls. `tool_execution_started` is the
execution boundary: a Tool Call without that event is unstarted. `cancelled` is reserved for a call
that crossed that boundary and was aborted; `skipped` is reserved for an unstarted Tool Call when
the Agent Run begins terminating, such as after cancellation, a fatal failure, or an exhausted
limit. A skipped call records the run-ending reason and has no Tool Result because no later Model
Turn will occur.

An in-progress Assistant Message lives outside the canonical transcript. Renderable text and
explicitly displayable reasoning update that partial message. Opaque provider reasoning is retained
for provider round-tripping but is not published as displayable content. Tool Call argument
fragments remain internal until complete; invalid partial JSON is never exposed as a Tool Call.

A successfully completed Assistant Message is appended to the canonical transcript. Failed or
cancelled partial output remains available for diagnostics but is never replayed to a provider.
Agent Core immediately commits a model-facing message for each Tool Result to the canonical
transcript. That message contains only the provider's Tool Call ID, `content`, and `isError`. The
AI adapter batches or reorders these result blocks when a provider requires a stricter wire
representation.

Approval and Verification records stay in Agent State and the Run Event log. They enter model
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
JavaScript `Error` values and mutable references never enter Agent State, Run Events, or Agent
Result.

Every terminal state contains the same Agent Result published by `run_settled` and returned by
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

The full transcript and event log remain available through Agent Run observation and are not
duplicated in Agent Result. Coding Agent maps this provider-neutral result to presentation and
process exit behavior.

### 5. Cancellation and workspace mutation

An accepted cancellation enters `cancelling` immediately, schedules no new work, and signals the
active model, tool, or Verification adapter through its `AbortSignal`.

For active duration, the first committed `runtime_limit_reached` event decides the race: a breach
recorded before `cancel` owns settlement with `LIMIT_EXCEEDED`, while an accepted cancellation
before the breach remains a cancellation. The limit event is committed as soon as the deadline is
observed, even when the Agent Run must still wait for the active effect or its grace period to end.

- With no active effect, the Agent Run quiesces synchronously.
- A pending Approval resolves as cancelled with `decidedBy: "user"`, because the accepted `cancel`
  command is the user's decision to terminate the Agent Run.
- The Tool Call associated with that pending Approval has not emitted `tool_execution_started`, so
  it receives a skipped outcome, not a cancelled outcome, and has no Tool Result.
- An executing Tool Call receives a cancelled outcome; any later queued, unstarted Tool Calls
  receive skipped outcomes in model order.
- A partial Assistant Message and its Model Turn complete with cancelled outcomes.
- An active Verification run completes with a cancelled outcome.
- Provider-side computation or billing may continue when that provider lacks native cancellation;
  this capability difference is preserved as diagnostic metadata.

The Agent Run enters `cancelled` only after active work quiesces. If an adapter ignores cancellation
beyond the grace period, the Agent Run enters `failed` with `CANCELLATION_TIMEOUT`; it never claims
a safe cancellation while an effect may still be running.

Agent State and Agent Result expose `workspaceChanged` and `partialChangesPossible`:

- pre-execution rejection changes neither value;
- beginning a mutating Tool Call sets `workspaceChanged` conservatively;
- failure or cancellation of a mutating Tool Call sets `partialChangesPossible`;
- terminal failure or cancellation after any mutation began sets `partialChangesPossible`;
- a successful Agent Run may still report `partialChangesPossible` if an earlier non-transactional
  mutation failed before the model recovered.

These rules reflect the accepted tool contract: `write` and `edit` protect their target files, but
parent directories may remain, while `bash` is explicitly non-transactional.

### 6. Run Event protocol

Every Run Event has this envelope:

```typescript
interface RunEventEnvelope<TType extends string, TData> {
  readonly runId: string;
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
Run
  run_started
  cancellation_requested
  runtime_limit_reached
  run_settled

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
| `run_started` | Coding Task |
| `model_turn_started` | Model Turn ID/index and model identity |
| `assistant_message_started` | Model Turn and Assistant Message IDs |
| `assistant_content_delta` | Message/block IDs, displayable content kind, and delta |
| `assistant_message_completed` | Message ID, `completed \| failed \| cancelled`, final or partial message, optional failure |
| `tool_call_queued` | Model Turn ID, queue index, normalized Tool Call |
| `approval_requested` | Approval ID, Tool Call ID, mutation summary, policy |
| `approval_resolved` | IDs, `allowed \| denied \| auto_approved \| cancelled`, `decidedBy: "user" \| "policy"`, optional reason |
| `tool_execution_started` | Tool Call ID and start metadata |
| `tool_execution_progress` | Tool Call ID and bounded progress update |
| `tool_call_completed` | Tool Call ID, `succeeded \| failed \| denied \| cancelled \| skipped`, and the full Tool Result when one exists |
| `candidate_completion_detected` | Model Turn and Assistant Message IDs |
| `model_turn_completed` | Model Turn ID, `completed \| failed \| cancelled`, usage, optional failure |
| `verification_started` | Verification ID and Candidate Completion reference |
| `verification_progress` | Verification ID and bounded evidence/progress update |
| `verification_completed` | Verification ID, `succeeded \| continue \| failed \| cancelled`, evidence, optional feedback |
| `cancellation_requested` | reason and state from which cancellation was requested |
| `runtime_limit_reached` | limit kind, configured limit, and observed value |
| `run_settled` | Agent Result |

The existing `tool_call_completed` event carries validated `details` as part of the full Tool
Result when a successful Tool Call provides them. Agent Core validates the payload as specified in
[ADR 0004 §3](./0004-package-apis-and-dependency-direction.md#3-coding-agentagent-core). The Run Event
union stays closed.

A generic `state_changed` event, provider wire events, and consumer-specific TUI events are
deliberately excluded. State transitions commit before their Run Events are appended, so an
observer handling an event always sees a snapshot at least as new as that event.

Lifecycle invariants are strict:

- `run_started` is the first event;
- every started Model Turn, Assistant Message, Tool Call, Approval, and Verification run receives
  exactly one completion or resolution event, including on failure and cancellation;
- content deltas and progress occur only between their corresponding start and completion events;
- a Model Turn completes only after its Assistant Message and all queued Tool Calls complete;
- `run_settled` occurs exactly once, carries the same Agent Result returned by `result()`, and
  is always the final event;
- Agent State is terminal before `run_settled` is published, and `result()` resolves only after
  that event has been appended.

For automatically approved mutating Tool Calls, Agent Core emits adjacent `approval_requested` and
`approval_resolved` events with `auto_approved` and `decidedBy: "policy"`, without entering
`awaiting_approval`. Read-only Tool Calls emit no Approval events.

### 7. Observation and retention

The producer never awaits consumers. Run Events are appended to Agent Core-owned queues and
the bounded Agent Run's complete in-memory event log before subscribers are notified. Consumer
exceptions terminate only that consumer and cannot fail the Coding Task.

`events()` defaults to replaying from sequence zero and then following live events. A consumer can
read a snapshot and call `events(snapshot.lastSequence)`; Agent Core atomically replays events after
that sequence and attaches the live stream, preventing gaps between snapshot and subscription.

The protocol has no per-event schema version. Package versioning and exhaustive TypeScript unions
are the compatibility contract. A schema version becomes necessary only if Run Events later
cross a process boundary or become persistent data.

### 8. Amendments

On 2026-11-12, [CDA-71](https://datn-fit-hcmus.atlassian.net/browse/CDA-71) amended this record:

- **Tool Progress bounds** (§6): a `tool_execution_progress` update carries the latest tail of the
  tool's output, at most 2,048 UTF-8 bytes cut at a character boundary, and replaces the previous
  update. Agent Core delivers at most one per 250 ms per Tool Call. An update that arrives sooner
  is held, a newer one replaces it, and the held update is delivered when the interval ends. An
  update equal to the last one is dropped. An update still held when the Tool Call completes is
  discarded, because `tool_call_completed` carries the full Tool Result, and an update after that
  is ignored. A command that prints for the full 120 s adds about 1 MB to the in-memory event log.
  ADR 0005 already leaves progress out of `events.jsonl`. Tool Progress is not part of Agent State.

On 2026-11-17, [CDA-83](https://datn-fit-hcmus.atlassian.net/browse/CDA-83) amended this record:

- **`MODEL_FAILURE` details** (§4): `AgentFailure` is a union. A `MODEL_FAILURE` always carries
  `details` of the declared type `ModelFailureDetails`, `{ phase: "request" | "stream" | "finish";
  reason: string; rawReason?: string; httpStatus?: number }`. The other failure codes keep the
  `details` of §4 unchanged. `httpStatus` is the provider's HTTP status when a response failed the
  request, an integer from 100 to 599. Agent Core settles `MODEL_PROTOCOL_ERROR` for any other
  value. [ADR 0005](./0005-terminalbench-evaluation-protocol.md) §7 reads it, and its Dependencies
  note says which providers record it.

On 2026-11-18, [CDA-77](https://datn-fit-hcmus.atlassian.net/browse/CDA-77) amended this record:

- **A cancelled Verification run** (§4, §5): when the policy decides, it still returns exactly one
  of the three decisions. A run the abort signal ended is not decided: the policy reports it as
  cancelled (`VerificationCancelled`, ADR 0004 §3), and Agent Core completes the Verification run
  with a cancelled outcome as §5 states. When a breached limit aborted the Verification run, the
  Agent Run settles `LIMIT_EXCEEDED` as §4 states. A cancelled report at any other time settles
  `INTERNAL_ERROR`.

On 2026-11-24, [CDA-147](https://datn-fit-hcmus.atlassian.net/browse/CDA-147) amended this record:

- **Agent Session is renamed Agent Run** (title, Context, §1 to §8): the lifecycle of one Coding
  Task is an Agent Run, which frees Session for the conversation a person sees, holding many Agent
  Runs and saved and reopened. Session Events are Run Events. The record uses the new names in
  place: `AgentRun`, `RunCommand`, `RunEvent`, `RunEventEnvelope`, `runId` (was `sessionId`), and
  `run_started` and `run_settled` (were `session_started` and `session_settled`). Behavior is
  unchanged. The file name is kept so that links to this record still resolve.

On 2026-11-25, [CDA-166](https://datn-fit-hcmus.atlassian.net/browse/CDA-166) amended this record:

- The model-facing Tool Result message (§3) contains only the provider's Tool Call ID, `content`,
  and `isError`.
- The existing Tool Call completion event (§6) carries the full Tool Result, including validated
  `details` when present on success.
  [Tool Details decision](https://datn-fit-hcmus.atlassian.net/browse/CDA-155?focusedCommentId=10375)

On 2026-11-26, [CDA-138](https://datn-fit-hcmus.atlassian.net/browse/CDA-138),
[CDA-139](https://datn-fit-hcmus.atlassian.net/browse/CDA-139) and
[CDA-141](https://datn-fit-hcmus.atlassian.net/browse/CDA-141), recorded with the rest of stage 1 in
[ADR 0009](./0009-multi-prompt-sessions-and-session-resume.md), amended this record. A Session runs
each of its Coding Tasks as a new Agent Run over one Transcript; ADR 0004 §10 gives the types.

- **The Transcript an Agent Run starts from** (§1, §2): construction takes an optional
  `transcript`, the Session's Transcript, empty by default and validated with the rest of the
  configuration before `ready`. A carried Transcript with an unanswered `tool_call`, a
  `tool_result` that answers no earlier call, or duplicate ids is refused with
  `INVALID_CONFIGURATION`. Agent State's common data and the `run_started` payload gain
  `carriedMessages`, the length of the carried Transcript, so the run's own messages are
  `transcript.slice(carriedMessages)`. `task` stays the prompt that opened the run.
- **Invariants** (§3): (I1) the carried Transcript is an unchanged prefix of the run's Transcript,
  since a run only appends; (I2) a settled run's Transcript is closed, every Tool Call having a Tool
  Result; (I3) construction refuses the carried Transcripts the bullet above names; (I4) every
  message appended to the Transcript is carried by exactly one Run Event: the Coding Task by
  `run_started`, a completed Assistant Message by `assistant_message_completed`, a Tool Result or
  Closing Tool Result by `tool_call_completed`, Verification feedback by `verification_completed`, a
  Steer by `steer_taken`, and an Outcome Note by `run_settled`.
- **Closing Tool Results** (§3, §5): each Tool Call that ends without a result of its own gets a
  Closing Tool Result with `isError: true`, committed to the Transcript and carried on
  `tool_call_completed`. A skipped call gets one, the call of a pending Approval at cancellation
  included. A completed Assistant Message whose Tool Calls are not yet queued when the run settles,
  as when a cancellation lands between `assistant_message_completed` and the first
  `tool_call_queued`, has each call queued and skipped, so each gets a Closing Tool Result. A call
  stopped while running keeps the tool's own result when the tool returned within the Cancellation
  Grace Period (`bash` returns its partial output and a `cancelled` status), and gets a Closing Tool
  Result otherwise. This supersedes §3's "A skipped call records the run-ending reason and has no
  Tool Result because no later Model Turn will occur" and §5's "has no Tool Result": a later Agent
  Run carries the Transcript, and Anthropic and OpenAI reject a request holding a Tool Call without
  a result. An interrupted Assistant Message is still never carried; no Tool Call in it ran, since
  calls are queued only after `assistant_message_completed`.
- **Outcome Notes** (§4, §6): every settlement without success (cancelled, and every failure code,
  `LIMIT_EXCEEDED` included) appends an Outcome Note, a user message telling the model how that
  Coding Task ended. A successful run gets none. The `run_settled` payload becomes
  `{ result, outcomeNote?, wordingFailure? }`, and the terminal Agent State holds the note in the
  Transcript before the event is published. Without it, a Coding Task cancelled before any reply
  would stay in the Transcript as an unanswered request that the model may carry out with the next
  one.
- **Wording** (§1): Agent Core decides when a Closing Tool Result or an Outcome Note is added; a
  required, synchronous and pure `TranscriptWording` port, which Coding Agent supplies, decides the
  words, and a note it returns as `undefined` is not added. If the port throws, the outcome stands,
  a Closing Tool Result has empty content with `isError: true`, no Outcome Note is added, and
  `run_settled` records the failure in `wordingFailure`.
- **Steers** (§1, §3): an Agent Run takes Steers through an optional `SteerSource` port, whose
  `take()` Coding Agent implements over its Prompt Queue; without the port the run takes none. The
  command union is unchanged. The run calls `take` just before each Model Turn's request, the first
  included, after the cancellation check and the Run Limit check, and commits the Steer to the
  Transcript in the same tick, so a queued Steer is either still editable or already taken. It takes
  at most one per Model Turn, and none while streaming, between the Tool Calls of a batch, during
  Verification or while cancelling. After a Verification `continue`, the request carries the
  feedback, then the Steer. A Steer waiting through an Approval decides nothing and waits until the
  batch resolves. A taken Steer is appended as a plain user message holding the person's text, so
  in the Transcript alone it looks like a Coding Task; the boundary lives in the Run Events. It
  resets no Run Limit counter. A `take` that throws, or returns anything but
  `{ id: string; text: string }` with non-empty `text`, settles `INTERNAL_ERROR`, since the item may
  already have left the queue.
- **A Candidate Completion with a Steer waiting** (§2, §4): when another Model Turn fits within the
  Run Limits and `take` returns a Steer, the run appends it and starts that Model Turn without
  entering Verification; `candidate_completion_detected` is still emitted. §2 gains the transition
  from `streaming_model` to `streaming_model` on a Candidate Completion when a Steer is taken. When
  another Model Turn would breach a limit, the run enters Verification without calling `take`, so a
  late Steer never turns a verifiable run into `LIMIT_EXCEEDED`. A decided Verification is final:
  `succeeded` and `failed` settle, and a waiting Steer stays in the Prompt Queue. §4's "No automatic
  retry, steering, prompt queue, pause, resume, or recovery exists in this MVP" drops steering and
  the prompt queue. An Agent Run is still never resumed: a resumed Session opens a new one.
- **`steer_taken`** (§6): the union gains a twentieth type, `steer_taken`, with payload
  `{ steerId: string; message: UserMessage }`, where `steerId` is the Prompt Queue item's id; Agent
  Core issues no id of its own for a Steer. It is a point event with no completion pair and adds no
  phase. It is committed before the `model_turn_started` of the Model Turn that carries the Steer:
  after a batch, `tool_call_completed`, `model_turn_completed`, `steer_taken`,
  `model_turn_started`; at a Candidate Completion, `candidate_completion_detected`,
  `model_turn_completed`, `steer_taken`, `model_turn_started`, with no `verification_started`; after
  a `continue`, `verification_completed`, `steer_taken`, `model_turn_started`; on the first Model
  Turn, `run_started`, `steer_taken`, `model_turn_started`.
- **Persistence** (§1, §7): Run Events are persistent data in two files, `events.jsonl` (ADR 0005
  §4) and the Session file (ADR 0009 §4), whose lines each carry a `schemaVersion` numbered per
  file. Stored Run Events are a durable record from which Coding Agent derives a Session's
  Transcript and redraws its view. They never restore an Agent Run, and §1's "not an
  event-sourcing or replay contract" stands.
- **Consequences**: persistent Sessions and steering are decided by this amendment and ADR 0009.
  Replay recovery, remote operation, concurrent tools and retries still need later decisions.

On 2026-11-28, [CDA-182](https://datn-fit-hcmus.atlassian.net/browse/CDA-182) amended this record:

- **Repeated Tool Call ids in a carried Transcript** (§3, §8): construction refuses a `tool_call`
  whose id repeats while the earlier call with that id has no `tool_result` yet, and a
  `tool_result` that answers a call a second time. An id may repeat once its earlier call is
  answered. This replaces "duplicate ids" in the 2026-11-26 amendment's list of refused Transcripts,
  which I3 names: the OpenAI-compatible adapter names a call `call_<blockIndex>` when the provider
  sends no id, so ids repeat across Model Turns and a Session would refuse its own Transcript. A
  model response that names one id twice settles `MODEL_PROTOCOL_ERROR` and its Assistant Message
  is not committed, since a Tool Result could not tell those calls apart.
- **No Outcome Note before `start`** (§4, §8): an Agent Run that settles before `start`, as when it
  is cancelled in `ready`, gets no Outcome Note, since it appended no Coding Task for a note to
  answer. This narrows "every settlement without success" in the 2026-11-26 amendment to runs that
  started.

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
