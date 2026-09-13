# Package APIs and Dependency Direction

Status: proposed

Date: 2026-09-13

## Context

[Define package APIs and dependency direction](https://datn-fit-hcmus.atlassian.net/browse/CDA-20)
asks what public interfaces and dependency direction should connect `@coding-agent/ai`,
`@coding-agent/agent-core`, `@coding-agent/tui`, and `@coding-agent/coding-agent` while keeping
each module deep, independently testable, and not API-compatible with Pi by accident.

`packages/ai` is the only package with source code and a manifest. `packages/agent-core` and
`packages/coding-agent` contain only a `CONTEXT.md`; `packages/tui` also holds `prototype/`, which
[Choose the TUI framework and interaction model](https://datn-fit-hcmus.atlassian.net/browse/CDA-17)
declares throwaway evidence that must not ship. No package imports another yet. Biome enforces
`useImportType`, and Lefthook and CI both reject relative imports, but nothing enforces package
boundaries.

Earlier decisions constrain this one. The
[tool-contract and safety decision](./0001-tool-contracts-and-safety-policy.md) fixes the four tool
contracts and the Approval Policy, and assigns execution, path validation, and approval states to
Agent Core. The
[Agent Session state-machine decision](./0002-agent-session-state-machine-and-event-protocol.md)
fixes the Agent Session interface and Session Event protocol, requires construction to validate its
adapters and return a configuration error, and leaves the exact exported type organization to this
ticket. The [provider semantics research](../research/provider-semantics.md) for
[Compare streaming and tool-calling semantics across MVP providers](https://datn-fit-hcmus.atlassian.net/browse/CDA-15)
defines the provider-neutral contract `packages/ai` must expose. The current exports do not
implement it: `Context` has no tools, stream events carry only text, there is no tool-result
content, and no capabilities or raw provider values are exposed.

## Decision

### 1. Dependency direction

`@coding-agent/coding-agent` is the single composition root. A leaf package may reference a
sibling's types; it never constructs or calls a sibling. Every collaborator is injected by the
composition root.

The allowed edges are:

| From | To | Edge | Reason |
| --- | --- | --- | --- |
| `coding-agent` | `ai`, `agent-core`, `tools`, `tui` | runtime | constructs and wires concrete instances |
| `tools` | `agent-core` | type-only | implements Agent Core's tool and workspace ports |
| `agent-core` | `ai` | type-only | `ai` owns the message, content, and stream vocabulary |
| `ai` | none | — | knows nothing of Agent Sessions, tools, or presentation |
| `tui` | none | — | owns its view types and receives already-projected data |

The table is an allowlist. Every other edge is forbidden, including any edge into `coding-agent`,
any edge out of `ai` or `tui`, `agent-core → tools`, `tools → ai`, and any cycle.
`@coding-agent/tools` is a fifth package that CDA-20 does not name; §4 gives the reason and the
fallback.

"Type-only" describes built output, not installation. Agent Core's public types expose `ai` types —
an Agent Result carries an `AssistantMessage` — so consumers need `ai` to typecheck. Every allowed
edge, including a type-only one, is therefore a `dependencies` entry. The checkable claim is that no
leaf package's built JavaScript imports a sibling (§9).

Two corollaries follow. `ai` never requires callers to identify errors with `instanceof`, because
that check is a value import; errors carry a discriminant field. No value that crosses a package
boundary is a TypeScript `enum`, because an enum compiles to a runtime object; boundaries use
string-literal unions.

`CONTEXT-MAP.md` records an Agent Core ↔ Terminal UI relationship. It is realized through Coding
Agent's projection (§6), not through a package edge.

### 2. `@coding-agent/ai`

`ai` owns Model Provider transport and authentication, and normalizes streaming, Tool Calls, usage,
cancellation, and finish reasons into one provider-neutral Model Interaction contract.

The contract follows the six normalized shapes in the provider semantics research. This decision
adopts their semantics, not their spelling. Field names are camelCase, as in ADR 0001, ADR 0002, and
the existing `ai` code, so the research's `tool_call_id` and `is_error` become `toolCallId` and
`isError`. Discriminant values stay snake_case, as in ADR 0002's Session Event types, so the
research's event and block names such as `content_block_delta`, `tool_call`, and `tool_result` are
kept. Wire spellings stay inside the provider mappings.

Tool Call argument fragments are accumulated inside `ai` and are never exported. A completed
`tool_call` block carries the complete argument text, and Agent Core parses it as step 2 of ADR
0002's preflight. Complete but malformed JSON therefore still reaches the Agent Session and becomes
an error Tool Result instead of disappearing inside a provider adapter.

`Provider.stream()` returns a structural type rather than the concrete `AssistantMessageEventStream`
class. A consumer that constructs a stream — every Agent Core test with a fake model — would
otherwise need `createAssistantMessageEventStream()` at runtime and turn the type-only edge into a
value import. The class remains an implementation that satisfies the type.

```typescript
export type ModelStream = AsyncIterable<ModelStreamEvent> & {
  result(): Promise<AssistantMessage>;
};
```

Differences between Model Providers and API families are declared, not left as undocumented
behavior. The research requires each deviation to remain an explicit, typed escape hatch. The
API-variant selector it calls for — OpenAI Chat Completions or Responses, Google `generateContent`
or Interactions, and xAI's two endpoints — is provider configuration, not a separate provider
identity. Each configured model exposes at least these capabilities:

```typescript
export interface ModelCapabilities {
  readonly parallelToolCallControl: boolean;
  readonly cancellation: "client_abort_only" | "native_in_flight";
  readonly toolArgumentDelivery: "streamed" | "whole";
  readonly usageTiming: "incremental" | "final";
  readonly serverSideTools: boolean;
}
```

Agent Core reads only `parallelToolCallControl` (ADR 0002 §3) and `cancellation`, which ADR 0002 §5
preserves as diagnostic metadata. Argument delivery and usage timing are normalized inside `ai`.

`ai` exports the declaration half of a tool and nothing about execution, because ADR 0001 assigns
schema types to AI and `Context.tools` needs a shape:

```typescript
export interface ToolDeclaration<S extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: S;
}
```

`ai` may retry a request only before its response stream opens, with a bound the caller sets and
may set to zero, and never after the first stream event. Retries consume ADR 0002's
active-execution budget and may be billed. ADR 0002 states that no automatic retry exists in this
MVP; this decision reads that statement as governing the Agent Session after a model failure, and
treats a bounded transport retry as a narrower mechanism. Reviewers who read ADR 0002 as excluding
transport retries as well should require a bound of zero, which this contract permits.

Not exported: SDK clients, the HTTP layer, retry internals, per-provider quirk shims, and partial
Tool Call argument accumulation.

### 3. `@coding-agent/agent-core`

Agent Core owns the Agent Session lifecycle and state machine, Tool Call preflight and dispatch, the
path-validation step, Approval, the Verification phase, and the canonical transcript. It performs
no terminal, filesystem, or network I/O; every effect arrives through an injected port.

ADR 0002 fixes `dispatch`, `snapshot`, `events`, and `result`, the `SessionCommand` and
`CommandResult` unions, the Session Event envelope, and the nineteen Session Event types. This
section adds construction and the model, Verification, workspace, and tool ports.

Construction returns a result, because ADR 0002 requires invalid construction to return a
configuration error and create no Agent Session:

```typescript
export type OpenSessionResult =
  | { ok: true; session: AgentSession }
  | { ok: false; code: "INVALID_CONFIGURATION"; message: string; field?: string };

export function openAgentSession(config: {
  model: ModelPort;
  systemPrompt: string;
  tools: ToolRegistry;
  workspace: WorkspaceResolver;
  approvalPolicy: ApprovalPolicy; // "ask" | "auto-approve" (ADR 0001)
  verification: VerificationPolicy;
  limits: SessionLimits;
  clock: Clock;
  ids: IdGenerator;
}): OpenSessionResult;

export interface ModelPort {
  readonly identity: Model; // model identity for model_turn_started
  readonly capabilities: ModelCapabilities;
  stream(context: Context, request: { signal: AbortSignal; parallelToolCalls: false }): ModelStream;
}

export interface Clock {
  now(): string; // ISO-8601 wall-clock time for occurredAt
  monotonicMs(): number; // durations and the active-execution limit
}

export type IdKind =
  | "session"
  | "model_turn"
  | "assistant_message"
  | "tool_call"
  | "approval"
  | "verification";

export interface IdGenerator {
  next(kind: IdKind): string;
}

export interface SessionLimits {
  maxModelTurns: number;
  maxToolCalls: number;
  maxActiveExecutionMs: number;
  maxConsecutiveRecoverableToolFailures: number;
  cancellationGraceMs: number;
}
```

`model` is a port object rather than a bare function because Agent Core needs the model identity
for `model_turn_started` and the capabilities above. It is injected, so `ai` is never imported at
runtime. Agent Core always asks for parallel Tool Calls to be disabled (ADR 0002 §3); the port
ignores the request when the provider cannot honor it, and Agent Core still accepts a batch.
Sampling settings such as maximum output tokens are bound into the port by the composition root.

Cancellation has one path, `dispatch({ type: "cancel" })`, so every cancellation passes through ADR
0002's serialized command queue and emits `cancellation_requested`. The composition root maps
process signals to that command. `SessionLimits` has no separate Verification-attempt limit,
because ADR 0002 excludes one; concrete values are Coding Agent configuration.

The Verification port carries ADR 0002's three decisions:

```typescript
export interface VerificationPolicy {
  verify(
    candidate: {
      transcript: readonly Message[];
      finalMessage: AssistantMessage;
      workspaceChanged: boolean;
    },
    ctx: { signal: AbortSignal; onProgress(update: VerificationProgress): void },
  ): Promise<VerificationDecision>;
}

export type VerificationDecision =
  | { decision: "succeed"; evidence: readonly VerificationEvidence[] }
  | {
      decision: "continue";
      evidence: readonly VerificationEvidence[];
      feedback: VerificationFeedback;
    }
  | { decision: "fail"; evidence: readonly VerificationEvidence[]; message: string };
```

The shapes of `VerificationEvidence`, `VerificationFeedback`, and `VerificationProgress` belong to
[Define MVP context, planning, verification, and session memory](https://datn-fit-hcmus.atlassian.net/browse/CDA-23);
until then they are ADR 0002's serializable JSON records.

ADR 0001 assigns path validation to Agent Core. Agent Core owns the step: when it runs (preflight,
before Approval), what it guarantees, and what a failure becomes. The step is expressed as a port
with a branded path type, so an unvalidated string cannot be passed where a validated path is
required:

```typescript
export type RepoPath = string & { readonly __brand: "RepoPath" };

export type PathResolution =
  | { ok: true; path: RepoPath }
  | {
      ok: false;
      code: Extract<ToolErrorCode, "PATH_OUTSIDE_REPO" | "NOT_FOUND" | "PERMISSION_DENIED">;
      message: string;
    };

export interface WorkspaceResolver {
  readonly repoRoot: RepoPath;
  resolveExisting(input: string): Promise<PathResolution>;
  resolveForCreate(input: string): Promise<PathResolution>;
}
```

`resolveExisting` canonicalizes with `fs.realpath` and rejects symbolic links and paths outside the
repository root. `resolveForCreate` verifies the deepest existing parent as ADR 0001 §2 requires and
creates nothing. Whether a resolved path must be a file or a directory remains each tool's check.

The tool port has two phases. ADR 0002 performs repository, path, and working-directory checks in
step 4, before Approval in steps 5 and 6. With a single `execute`, a person would be asked to
approve `write ../../x` only for the path check to fail afterwards, and Agent Core would have
nothing to put in `approval_requested`'s mutation summary.

```typescript
export type ToolMutation = "read_only" | "mutating";

export interface PrepareContext {
  readonly workspace: WorkspaceResolver;
  readonly signal: AbortSignal;
}

export interface ExecuteContext extends PrepareContext {
  onProgress(update: ToolProgress): void; // source of tool_execution_progress
}

export interface PreparedCall<S extends TSchema> {
  readonly input: Static<S>;
  readonly paths: readonly RepoPath[]; // validated during prepare
  readonly summary: string; // mutation summary for approval_requested
}

export type PrepareOutcome<S extends TSchema> =
  | { ok: true; prepared: PreparedCall<S> }
  | { ok: false; code: ToolErrorCode; message: string };

export type ToolOutcome =
  | { isError: false; content: string; truncated?: boolean }
  | {
      isError: true;
      content: string;
      error: { code: ToolErrorCode; message: string };
      truncated?: boolean;
    };

export interface ExecutableTool<S extends TSchema = TSchema> extends ToolDeclaration<S> {
  readonly mutation: ToolMutation;
  prepare(input: Static<S>, ctx: PrepareContext): Promise<PrepareOutcome<S>>;
  execute(prepared: PreparedCall<S>, ctx: ExecuteContext): Promise<ToolOutcome>;
}

export interface ToolRegistry {
  get(name: string): ExecutableTool | undefined;
  list(): readonly ExecutableTool[];
}
```

`prepare` runs after Schema Validation, has no side effects, and receives no progress callback,
because ADR 0002 permits progress only between `tool_execution_started` and the Tool Call's
completion. `execute` re-validates `prepared.paths` through `ctx.workspace`, because waiting for
Approval leaves time for the filesystem to change.

`mutation` is declared on the tool rather than looked up in a policy table, so Agent Core decides
Approval from the registry alone: `read` is read-only and auto-approved, while `write`, `edit`, and
`bash` are mutating and gated under `"ask"`, as ADR 0001 requires.

Tools return `ToolOutcome`, not `ToolResult`. A tool that returned a full `ToolResult` would set
`toolCallId` and `metadata.approval.decidedBy` itself, making the audit trail forgeable by the
component being audited. Agent Core assembles ADR 0001's `ToolResult` from the outcome, the Tool
Call ID, the tool name, the measured duration, and the Approval metadata that only Agent Core holds.
`ToolResult`, `ToolErrorCode`, and `ToolProgress` are exported from Agent Core.

`prepare` and `execute` report every expected failure as a returned code and must not throw. ADR
0002 requires a tool failure to become an error Tool Result, but ADR 0001's `ToolErrorCode` has no
code for an unexpected failure, so the result recorded for a thrown exception needs an ADR 0001
amendment (see Consequences). After an accepted cancellation, Agent Core records an executing Tool
Call as cancelled whether `execute` resolves or rejects, and waits for it to settle within the
cancellation grace period (ADR 0002 §5).

Not exported: the state machine implementation and the Tool Call scheduler. Agent Core performs no
automatic retry or recovery (ADR 0002 §4) and no history compaction; context and memory belong to
CDA-23.

### 4. `@coding-agent/tools`

CDA-20 was created on 2026-08-16, before ADR 0001 turned the four tools into substantial filesystem
and process logic: `fs.realpath` canonicalization, symbolic-link rejection, temporary-file writes
with atomic rename, bash timeout bounds, and a 40 KiB head-and-tail output budget. In
`coding-agent`, that logic would contradict the thin composition root in §6. In `agent-core`, it
would give the package whose tests must be fastest a dependency on `node:fs` and
`node:child_process`.

`@coding-agent/tools` therefore holds the four tool implementations and the filesystem
implementation of `WorkspaceResolver`, and it type-imports the ports from `agent-core`. This
exceeds CDA-20's four-package framing and must be confirmed in review. If the team keeps four
packages, the same implementations move into `agent-core` behind the same ports, `agent-core`
accepts the I/O dependency, and no public type in this decision changes.

This placement relies on a reading of ADR 0001: its assignment of path validation to Agent Core is
read as ownership of the validation step and its guarantees, which stay in Agent Core (§3), while
the filesystem code that performs the step lives here. If review reads ADR 0001 as requiring that
code inside `agent-core`, this section amends ADR 0001 and must say so when accepted.

```typescript
export function createWorkspaceResolver(
  repoRoot: string,
): Promise<
  | { ok: true; workspace: WorkspaceResolver }
  | { ok: false; code: "INVALID_CONFIGURATION"; message: string; field: "repoRoot" }
>;

export function createDefaultTools(): ToolRegistry;
export function readTool(): ExecutableTool<typeof ReadParams>;
export function writeTool(): ExecutableTool<typeof WriteParams>;
export function editTool(): ExecutableTool<typeof EditParams>;
export function bashTool(): ExecutableTool<typeof BashParams>;
```

`createWorkspaceResolver` canonicalizes and validates `repoRoot` once, which satisfies ADR 0002's
requirement that `repoRoot` be valid before the Agent Session reaches `ready`. Tools take no
`repoRoot` argument; it arrives through `ctx.workspace`. `bashTool` takes no timeout options,
because ADR 0001 fixes the 30-second default and the 120-second cap. Filesystem helpers inside the
package accept `RepoPath` rather than `string`, so skipping validation is a type error. Individual
tools are exported alongside the default registry so an evaluation harness can compose a narrower
one.

### 5. `@coding-agent/tui`

`tui` owns rendering and input capture for the Full-screen TUI. It has no knowledge of models,
Model Providers, tools, or Session Events.

CDA-17 selects Ink 7.1.1 as the internal renderer for reconciliation, layout, terminal diffing, and
terminal lifecycle. Transcript virtualization and scrolling, Approval presentation, input policy,
themes, and the interaction model are project-owned: an inline transcript by default, Approval
overlays composited over the transcript, and the split rail opt-in. Ink does not appear in this
package's public types, and the prototype's three-renderer switch does not become a production
abstraction.

```typescript
export function renderTui(props: { model: TuiModel; handlers: TuiHandlers }): TuiHandle;

export type TuiHandlers = {
  onSubmit(text: string): void;
  onCancel(): void;
  onApproval(approvalId: string, decision: "allow" | "deny", reason?: string): void;
};

export interface TuiHandle {
  update(model: TuiModel): void;
  unmount(): Promise<void>;
}
```

`tui` owns `TuiModel`. `onApproval` mirrors ADR 0002's `resolve_approval` command, so the adapter
renames arguments instead of translating them.

No terminal suspend-and-resume interface is specified. ADR 0001 runs `bash` non-interactively with
`CI=1`, `TERM=dumb`, and stdin closed, so no MVP tool contends for the terminal. An interactive tool
would first change ADR 0001's execution model and only then this interface; the CDA-17 prototype
notes that Ink provides `suspendTerminal()` for that case.

### 6. `@coding-agent/coding-agent`

Coding Agent owns configuration, CLI parsing, Model Provider and model selection, the `ModelPort`
adapter over `ai`, the TUI projection, wiring, process lifecycle, and exit codes. It is the only
package with a `bin` entry and a build that produces an executable.

```typescript
export function runInteractive(opts: CliOptions): Promise<number>;
export function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult>;
export function projectSessionEvent(event: SessionEvent, prev: TuiModel): TuiModel;
```

`projectSessionEvent` is the Session Event to `TuiModel` projection, following the
[Pi architecture research](../research/pi-architecture.md)'s recommendation that the event-to-view
adapter is application-owned. It is pure, has its own unit tests, and performs no I/O. Apart from
it, the package holds configuration, wiring, and process handling, not domain logic. ADR 0002 scopes
an Agent Session to exactly one Coding Task and has no prompt queue, so a submission opens a new
Agent Session only when no Agent Session is active.

The externally stable contract is the command line, not `runHeadless`. The
[Terminal-Bench integration research](../research/terminalbench-integration.md) for
[Determine TerminalBench integration requirements](https://datn-fit-hcmus.atlassian.net/browse/CDA-21)
recommends a Harbor installed agent that runs the built executable inside each task container. That
consumer depends on the flags, exit codes, and files written; `runHeadless` is the in-process
implementation behind them.
[Define the TerminalBench evaluation protocol](https://datn-fit-hcmus.atlassian.net/browse/CDA-24)
pins the invocation.

The same research recommends an ATIF trajectory at `/logs/agent/trajectory.json`. A trajectory is a
projection governed by ATIF's own schema. If raw Session Events are persisted as well, ADR 0002 §7's
condition for a Session Event schema version is met. CDA-24 decides where either writer lives.

`"auto-approve"` is selected only on the headless path, because ADR 0001 reserves it for isolated
execution harnesses.

### 7. Placement of later decisions

The Verification policy implementation lives outside `agent-core`. ADR 0002 has the Coding Agent
composition root supply it, and running checks needs I/O that §3 excludes. Agent Core owns only the
`VerificationPolicy` port and the Verification phase. CDA-23 decides the policy's checks and whether
the implementation needs its own package.

Context Intelligence, Planning, and Memory also belong to CDA-23. The Pi architecture research
recommends keeping context transformation at the model boundary. If CDA-23 adopts that, the
transformation arrives as an injected port on `openAgentSession`. Every such placement follows §1.

### 8. Relationship to Pi

`AGENTS.md` records Pi as the architectural reference point, not a dependency. No workspace package
depends on Pi. The only Pi package in any manifest is `@earendil-works/pi-tui` 0.85.1, which the
throwaway TUI prototype uses as a reference baseline.

Attribution is separate from naming. `packages/ai/src/utils/event-stream.ts`, added in `1da45ea`
(CDA-8), matches Pi's `packages/ai/src/utils/event-stream.ts` at the commit the Pi architecture
research examined, except for removed comments and lint fixes. Pi is MIT-licensed
(`Copyright (c) 2025 Mario Zechner`), and that license requires its copyright and permission notice
in copies or substantial portions. The repository carries no such notice, and renaming symbols does
not satisfy the requirement. The file must retain the notice or be rewritten; this applies to the
current code whether or not this decision is accepted.

The divergences that matter are structural: the allowlisted, type-only package graph with one
composition root; sequential Tool Call execution (ADR 0002 §3), where Pi runs calls in parallel by
default; ADR 0002's explicit states, sequence-ordered Session Events with replay, and `dispatch`
returning an acceptance result; Approval as a lifecycle state rather than a hook; and Verification
as an explicit phase.

Implementing the provider contract removes most naming overlap, because its stream vocabulary
follows Anthropic's wire naming rather than Pi's `text_start` and `toolcall_*` events, and its
finish-reason enum replaces `StopReason`. Every remaining public export that matches a Pi export is
renamed:

| Current | Becomes |
| --- | --- |
| `AssistantMessageEvent` | `ModelStreamEvent`, with members from the provider contract |
| `StopReason` | `FinishReason` plus the raw provider value |
| `TextContent` | the `text` content block |
| `ProviderStreams` | `ProviderApi` |
| `CreateProviderOptions` / `createProvider` | `ProviderOptions` / `defineProvider` |
| `builtinProviders` / `builtinModels` | `defaultProviders()` / `createProviderDirectory()` |
| `ModelsImpl` | `ProviderDirectory` |
| `ApiKeyAuth` / `ProviderAuth` / `envApiKeyAuth` | `ApiKeySource` / `ProviderCredentials` / `apiKeyFromEnv` |
| `EventStream`, `AssistantMessageEventStream`, `createAssistantMessageEventStream` | internal; `ModelStream` is exported |
| `providers/all.ts` | `providers/registry.ts` |

The replacement names were checked against Pi's exports. The names this decision introduces also
avoid Pi's public `createAgentSession`, `ToolDefinition`, and `ModelRegistry`
(`pi-coding-agent`), `AgentTool` (`pi-agent-core`), and `ApiKeyCredential` (`pi-ai`). `Model`,
`Message`, `UserMessage`, `AssistantMessage`, `Context`, `StreamOptions`, and `Provider` are kept as
domain terms.

A later public export that matches a Pi export is renamed, or kept with its reason recorded in the
decision that introduces it. The renamed symbols have no consumers outside `packages/ai`, so the
change is mechanical today.

### 9. Enforcement

Each new package gets a `package.json` that follows `packages/ai`: `private: true` and
`exports: { ".": "./src/index.ts" }`, which makes deep imports unreachable. Each manifest lists the
allowed edges from §1 in `dependencies` as `workspace:*`.

Forbidden edges are enforced with Biome's `noRestrictedImports` rule in per-package `overrides`. The
rule reports type imports, `export … from` re-exports, and dynamic `import()` of a restricted
package. Biome's `noEnum` rule enforces the enum corollary. Biome already runs in Lefthook and CI,
so these rules need no separate script.

Biome cannot express "allowed, but only as a type import". That rule is checked against build
output: CI bundles each leaf package's entry point with `bun build --external '@coding-agent/*'`
and fails if the output still imports or requires a `@coding-agent/*` package. Bun removes
type-only imports, so any remaining import is a runtime edge. CI is authoritative because hooks can
be skipped. This replaces "tests pass with siblings absent", which Bun workspaces cannot
demonstrate: every sibling is linked, and `bun test` does not typecheck.

## Consequences

- `ai` tests against recorded provider fixtures with no other package present. Agent Core tests use
  a fake `ModelPort`, fake tools, a fake `WorkspaceResolver`, an injected clock, and deterministic
  IDs, with no `ai`, `tools`, network, terminal, or wall-clock dependence; ADR 0002's nine states
  and nineteen Session Events need a large, fast suite. `tools` tests against a temporary
  repository. `tui` tests render hand-built `TuiModel` values through `@xterm/headless`.
  `coding-agent` needs a smoke test per entry point and unit tests for `projectSessionEvent`.
- Agent Core depends on the provider contract's type surface, which is a types-only change to `ai`,
  not on the provider implementations. `tools` and `tui` depend on neither. Implementation order
  belongs to
  [Decide implementation order and the MVP completion checklist](https://datn-fit-hcmus.atlassian.net/browse/CDA-22).
- Both SDK clients in `packages/ai` are currently constructed without `maxRetries`, so each retries
  failed requests twice by default. They must pass the bound from §2.
- `CONTEXT-MAP.md` must add `@coding-agent/tools` and remove its statement that package APIs and
  dependency direction are still undecided.
- Costs accepted: a fifth package; a rename pass across `packages/ai`; a two-phase tool port that is
  more work than a single `execute`; per-provider capability declarations; and an injected clock
  and ID generator that lengthen construction at the composition root.
- Before acceptance, review must confirm the fifth package and the reading of ADR 0001 in §4.
- Before Agent Core implements Tool Call dispatch, ADR 0001 needs an amendment that adds a
  `ToolErrorCode` for an unexpected tool failure.
- Before the first tool is written, the TypeBox package needs confirmation: ADR 0001 names
  `@sinclair/typebox`, whose current release is 0.34.52, while TypeBox 1.x is published as
  `typebox` (1.3.30), the package Pi uses. ADR 0001's bash `timeout` input also states no unit.
- `ToolProgress` is shaped with the first tool that reports progress; Agent Core owns and bounds
  it.
- `packages/ai/src/utils/event-stream.ts` must retain Pi's MIT notice or be rewritten (§8).
