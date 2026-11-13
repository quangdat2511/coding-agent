# Package APIs and Dependency Direction

Status: accepted

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
`@coding-agent/tools` is a fifth package added to CDA-20's original four; §4 gives the reason.

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

Throughout this decision, `TSchema` and `Static` are imported from `typebox` (TypeBox 1.x), as ADR
0001 §1 requires.

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
  ids: IdSource;
}): OpenSessionResult;

export interface ModelPort {
  readonly identity: Model; // model identity for model_turn_started
  readonly capabilities: ModelCapabilities;
  stream(context: Context, request: { signal: AbortSignal; parallelToolCalls: false }): ModelStream;
}

export interface Clock {
  now(): string; // ISO-8601 wall-clock time for occurredAt
  monotonicMs(): number; // durations and maxDurationMs
}

export type IdKind =
  | "session"
  | "model_turn"
  | "assistant_message"
  | "tool_call"
  | "approval"
  | "verification";

export interface IdSource {
  next(kind: IdKind): string;
}

export interface SessionLimits {
  maxModelTurns: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxConsecutiveRecoverableFailures: number;
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
because ADR 0002 excludes one; concrete values are Coding Agent configuration. Its field names
follow §4 of the
[MVP context, planning, verification, and session memory decision](./0003-mvp-context-planning-verification-and-session-memory.md)
(ADR 0003).

ADR 0003 §4, as amended by [CDA-35](https://datn-fit-hcmus.atlassian.net/browse/CDA-35), states the
counter's scope; this decision keeps the field name unchanged.

The Verification port carries ADR 0002's three outcomes, spelled as in ADR 0003 §3:

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
  | { outcome: "succeeded"; evidence: readonly VerificationEvidence[] }
  | {
      outcome: "continue";
      evidence: readonly VerificationEvidence[];
      feedback: VerificationFeedback;
    }
  | { outcome: "failed"; evidence: readonly VerificationEvidence[]; message: string };
```

`VerificationEvidence` is the closed union that ADR 0003 §3 defines (`command_execution`,
`command_system_failure`, and `no_command_configured`). `VerificationFeedback` is the structured
`[Verification Failed]` user message that ADR 0003 §3 injects into the next Model Turn after a
`continue` outcome. ADR 0003 §3 defines no progress payload, so `VerificationProgress` remains ADR
0002's bounded progress update.

As amended in ADR 0001 §2, Agent Core owns the path-validation step: when it runs (preflight, before
Approval), what it guarantees, and what a failure becomes. The step is expressed as a port with a
branded path type, so an unvalidated string cannot be passed where a validated path is required:

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

`prepare` and `execute` report every expected failure as a returned code and must not throw. If
either throws or rejects anyway, Agent Core records a recoverable error Tool Result with
`TOOL_INTERNAL_ERROR` (ADR 0001 §6), as ADR 0002 requires for tool failures; the exception itself
never enters Agent State. After an accepted cancellation, Agent Core records an executing Tool Call
as cancelled whether `execute` resolves or rejects, and waits for it to settle within the
cancellation grace period (ADR 0002 §5).

Not exported: the state machine implementation and the Tool Call scheduler. Agent Core performs no
automatic retry or recovery (ADR 0002 §4) and no history compaction; ADR 0003 §4 limits in-session
memory to the canonical transcript and defers compaction.

### 4. `@coding-agent/tools`

CDA-20 was created on 2026-08-16, before ADR 0001 turned the four tools into substantial filesystem
and process logic: `fs.realpath` canonicalization, symbolic-link rejection, temporary-file writes
with atomic rename, bash timeout bounds, and a 40 KiB head-and-tail output budget. In
`coding-agent`, that logic would contradict the thin composition root in §6. In `agent-core`, it
would give the package whose tests must be fastest a dependency on `node:fs` and
`node:child_process`.

`@coding-agent/tools` therefore holds the four tool implementations and the filesystem
implementation of `WorkspaceResolver`, and it type-imports the ports from `agent-core`. The fifth
package keeps `agent-core` free of `node:fs` and `node:child_process`, in the same port style ADR
0002 uses for its adapters, and keeps `coding-agent` a thin composition root. CDA-20's description
and `CONTEXT-MAP.md` list all five packages.

This placement follows ADR 0001 §2 as amended: Agent Core owns the path-validation step and its
guarantees (§3), while the filesystem code that performs the step lives here.

```typescript
export function createWorkspaceResolver(
  repoRoot: string,
): Promise<
  | { ok: true; workspace: WorkspaceResolver }
  | { ok: false; code: "INVALID_CONFIGURATION"; message: string; field: "repoRoot" }
>;

export function normalizeWindowsShellPath(input: string): string;
export function createDefaultTools(): ToolRegistry;
export function createChildEnvironmentBuilder(
  credentialEnvVars: readonly string[],
  platform?: NodeJS.Platform,
): CreateChildEnvironmentResult;
export function createChildProcessLauncher(
  credentialEnvVars: readonly string[],
): CreateChildProcessLauncherResult;
export function readTool(): ExecutableTool<typeof ReadParams>;
export function writeTool(): ExecutableTool<typeof WriteParams>;
export function editTool(): ExecutableTool<typeof EditParams>;
```

`createDefaultTools()` currently registers only `read`, `write`, and `edit`, and keeps its
zero-argument signature. The target API for CDA-71 is
`createDefaultTools(launcher: ChildProcessLauncher): ToolRegistry` and
`bashTool(launcher: ChildProcessLauncher): ExecutableTool<typeof BashParams>`. CDA-74 will add the
Verification Runner with the same configured launcher dependency. These are planned signatures,
not exports implemented by CDA-68. They replace the original zero-argument sketches when process
execution is added; they do not add tool timeout options.

The composition root reads the complete `PROVIDER_CREDENTIAL_ENV_VARS` export from `ai` and
supplies it to the launcher's factory in `tools`. The set includes every credential variable name
the CLI-selectable providers of ADR 0005 §3 declare, including providers not selected for the
current run. Custom Provider credential names are outside that declared set; extending the set
belongs with adding CLI support for them, and ADR 0001 §8 records the resulting inherited Custom
Provider credentials as a residual under both Approval Policies. `tools` receives names, never
imports `ai`, and never discovers additional names by prefix or by scanning for secret-looking
values.

On 2026-11-12, [CDA-30](https://datn-fit-hcmus.atlassian.net/browse/CDA-30) amended this record:
[ADR 0007](./0007-evaluation-provider-and-model.md) promotes `opencode` to a sixth `--provider`
value, so `OPENCODE_API_KEY` joins the declared set with it, and the sentence that placed OpenCode
credentials outside the set is superseded. The Custom Provider sentence stands.

Every child started by `bash` or the Verification Runner goes through this shared launcher. At
each launch it copies Coding Agent's current environment and removes exactly the configured
credential names. The name set stays fixed after construction; the environment is not a
session-start snapshot. Filtering does not change Coding Agent's own environment. Other variables,
including a task's `GH_TOKEN` and same-prefixed names outside the set, retain their current values
through filtering. Execution-mode requirements such as `CI=1` and `TERM=dumb` remain governed by
ADR 0001 §3; they are separate from the credential-filtering step.

Callers cannot pass a per-launch environment map to replace or extend the launcher's environment.
The launcher owns construction of the child environment, applies execution-mode settings before
the final credential filtering, and supplies that environment explicitly when starting the child.
No caller can merge variables into it after filtering. An absent or empty configured name set is
an `INVALID_CONFIGURATION` failure during launcher construction, before any child is started.

Credential names are matched case-insensitively on Windows and exactly on Linux and macOS,
following each platform's environment-variable naming rules. On Windows every matching key is
removed, including when an input object contains multiple case variants. Nonmatching names keep
their original spelling and values; prefix matches such as `OPENAI_API_KEY_BACKUP` are preserved.
The declared MVP names are ASCII, so this decision does not require broader Unicode case folding.

`createChildEnvironmentBuilder` returns either the configuration error above or an `ok: true`
result with a `build(parent)` function; each call returns an independent filtered environment.
Its optional platform argument permits testing Windows name matching on every host. The actual
launcher always uses the host platform. `createChildProcessLauncher` returns the same failure
shape or an `ok: true` result with a `ChildProcessLauncher`. Its
`launch(command, { cwd, detached }?)`
accepts an executable and argument array and returns the Bun child handle with piped stdout and
stderr, closed stdin, and an exit promise. Shell selection, tool timeouts, output budgeting, and
Verification result mapping belong to the later adapters; this factory does not execute a shell
or start any child during construction. `detached` defaults to false and forwards Bun's process
creation option: on POSIX it creates a new session and process group, allowing a later adapter to
signal the group rather than only the shell. On Windows it uses Bun's detached-process behavior;
it does not promise POSIX group signaling. The option does not unref the child or terminate its
descendants. CDA-71 and CDA-74 remain responsible for timeout, cancellation, descendant cleanup,
and bounded output draining. This avoids requiring those adapters to bypass the launcher just to
request process isolation. The credential filter and `CI`/`TERM` override share one internal
`environmentKeyOf` helper; this helper is not re-exported from the package entry point.

`createWorkspaceResolver` canonicalizes and validates `repoRoot` once, which satisfies ADR 0002's
requirement that `repoRoot` be valid before the Agent Session reaches `ready`. Tools take no
`repoRoot` argument; it arrives through `ctx.workspace`. `normalizeWindowsShellPath` converts the
Git Bash, MSYS, Cygwin, and WSL drive spellings (`/c/...`, `/mnt/c/...`, `/cygdrive/c/...`) to the
native Windows form before the composition root or the workspace resolver resolves a path; other
platforms pass the path through unchanged. `bashTool` takes no timeout options,
because ADR 0001 fixes the 30,000 ms default and the 120,000 ms cap for `timeoutMs`. Filesystem
helpers inside the package accept `RepoPath` rather than `string`, so skipping validation is a type
error. Individual tools are exported alongside the default registry so an evaluation harness can
compose a narrower one.

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
`VerificationPolicy` port and the Verification phase. ADR 0003 §3 fixes the checks: a configured
verification command runs non-interactively in `repoRoot`, its runner result maps to `succeeded`,
`continue`, or `failed`, and without a configured command the policy returns a non-gating
`succeeded`.

ADR 0003 settles context, planning, and memory without a new Agent Core port. Project instructions
from `AGENTS.md` or `CLAUDE.md` are capped at 32 KiB and packaged into the initial system prompt
with environment metadata (ADR 0003 §1). Planning is a system-prompt requirement with a `.scratch/`
convention rather than a runtime state (ADR 0003 §2). In-session memory is the canonical transcript,
with no compaction (ADR 0003 §4). The composition root therefore assembles the `systemPrompt` passed
to `openAgentSession`, because reading those files is filesystem I/O that §3 excludes from Agent
Core. Every such placement follows §1.

### 8. Relationship to Pi

`AGENTS.md` records Pi as the architectural reference point, not a dependency. No workspace package
depends on Pi. The only Pi package in any manifest is `@earendil-works/pi-tui` 0.85.1, which the
throwaway TUI prototype uses as a reference baseline.

Attribution is separate from naming. Pi is MIT-licensed (`Copyright (c) 2025 Mario Zechner`), and
that license requires its copyright and permission notice in copies or substantial portions, so
code adapted from Pi keeps that notice; renaming symbols does not satisfy the requirement.
`packages/ai/src/utils/event-stream.ts`, added in `1da45ea` (CDA-8), matches Pi's
`packages/ai/src/utils/event-stream.ts` at the commit the Pi architecture research examined, except
for removed comments and lint fixes. It must carry the notice or be rewritten; that work is separate
from this decision.

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
| `anthropicProvider`, `googleProvider`, `openaiProvider`, `opencodeProvider`, `openrouterProvider`, `xaiProvider` | `createAnthropicProvider()`, `createGoogleProvider()`, `createOpenAIProvider()`, `createOpencodeProvider()`, `createOpenRouterProvider()`, `createXaiProvider()` |
| `EventStream`, `AssistantMessageEventStream`, `createAssistantMessageEventStream` | internal; `ModelStream` is exported |
| `providers/all.ts` | `providers/registry.ts` |

The per-provider factories match Pi's `pi-ai/providers/*` subpath exports. The replacement names
were checked against Pi's public exports, including subpath exports. The names this decision
introduces also avoid Pi's public `createAgentSession`, `ToolDefinition`, and `ModelRegistry`
(`pi-coding-agent`), `AgentTool` (`pi-agent-core`), and `ApiKeyCredential` (`pi-ai`). `Model`,
`Message`, `UserMessage`, `AssistantMessage`, `Context`, `StreamOptions`, and `Provider` are kept as
domain terms.

The same comparison covers the other four packages. Their exported names were checked against the
public exports of `pi-ai`, `pi-agent-core`, `pi-tui`, and `pi-coding-agent` at the commit the Pi
architecture research examined, following each package's `exports` entry points and their
re-exports:

| Package | Names checked | Exact matches with a Pi public export |
| --- | --- | --- |
| `agent-core` | the ADR 0001 and ADR 0002 types it exports and the names in §3 (41 names) | `AgentSession` (`pi-coding-agent`), `AgentState` (`pi-agent-core`), `JsonValue` (`pi-agent-core`, `pi-ai`), `IdGenerator` (`pi-agent-core`) |
| `tools` | `createWorkspaceResolver`, `createDefaultTools`, `readTool`, `writeTool`, `editTool`, `bashTool`, `ReadParams`, `WriteParams`, `EditParams`, `BashParams`, `createChildEnvironmentBuilder`, `createChildProcessLauncher`, `ChildEnvironment`, `CreateChildEnvironmentResult`, `ChildLaunchOptions`, `ChildProcess`, `ChildProcessLauncher`, `CreateChildProcessLauncherResult` | none |
| `tui` | `renderTui`, `TuiModel`, `TuiHandlers`, `TuiHandle` | none |
| `coding-agent` | `runInteractive`, `runHeadless`, `projectSessionEvent`, `CliOptions`, `HeadlessOptions`, `HeadlessResult` | none |

| Match | Decision |
| --- | --- |
| `AgentSession` | kept: Agent Core glossary term, fixed by ADR 0002 |
| `AgentState` | kept: Agent Core glossary term, fixed by ADR 0002 |
| `JsonValue` | kept: generic name for ADR 0002's JSON value type; it encodes no design choice |
| `IdGenerator` | renamed to `IdSource` (§3) |

CDA-68's eight child-environment and launcher exports were checked again on 2026-11-11 against
the same Pi commit, `9841914c71a74d81abe07f751aefd271fd924e63`, including its package subpaths.
Seven names do not occur in the four packages' source. `ChildProcess` occurs as an imported Node
type and in internal implementation code, but is not a Pi public export. The package therefore
keeps these eight names; the shared internal helper above adds no package export.

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

A package imports its own files by relative path, keeping the source extension, and a sibling only
by its package name. Packages declare no `paths` aliases: `tsc` applies the compiling package's
`paths` to every sibling source it reads, so an alias inside one package breaks typechecking in the
packages that import it. A relative path can still reach into a sibling's `src/` and bypass its
`exports`. Neither check above sees that: `noRestrictedImports` matches only `@coding-agent/*`
names, and the bundle inlines the sibling's source. `bun run check:import-boundaries` resolves every
relative specifier in workspace package sources, including dynamic `import()`, and fails when one
lands outside the importing file's package; it also rejects `@/`, `@tests/` and `@examples/`
aliases. Lefthook and CI both run it.

### 10. Amendments

On 2026-10-07,
[Replace the @/ import alias with relative imports](https://datn-fit-hcmus.atlassian.net/browse/CDA-99)
amended this record:

- **Import boundaries** (§9): packages import their own files by relative path instead of a `@/`
  alias, and `check:import-boundaries` rejects aliases and relative imports that leave their
  package. This replaces the Lefthook and CI rule, noted in Context, that rejected relative
  imports.

On 2026-11-04,
[Replay Gemini thought signatures and call ids in the Google adapter](https://datn-fit-hcmus.atlassian.net/browse/CDA-102)
amended this record:

- **Provider Signature** (§2): a completed `tool_call` block may carry an optional `signature`
  that holds a Provider Signature. The adapter that produced it sends it back unchanged with that
  call on the next request, and nothing else reads it; Agent Core only checks that it is a string.
  Gemini 3 attaches its `thoughtSignature` to the `functionCall` part itself and rejects a replay
  without it, so the value lives on the Tool Call rather than in the research's separate opaque
  block.

On 2026-11-10,
[Build the credential-free child environment](https://datn-fit-hcmus.atlassian.net/browse/CDA-68)
amended this record:

- **Shared child launch dependency** (§4): the composition root configures one launch path for
  `bash` and the Verification Runner with AI's complete declared MVP credential-name set. This
  replaces relying on each caller to remember a standalone filtering helper, and replaces the
  zero-argument sketches for factories that include process execution.
- **Environment timing** (§4): children receive a newly filtered copy of the current parent
  environment at each launch, rather than a session-start snapshot. The configured credential-name
  set is fixed; other variables can change between launches.
- **Environment ownership** (§4): process callers cannot supply a replacement or supplemental
  environment map. The shared launcher constructs and explicitly supplies the filtered environment.
- **Platform name matching** (§4): Windows uses case-insensitive credential-name matching,
  removing all matching case variants; Linux and macOS use exact matching. Other names and values
  are preserved.

The standalone logic prototype and its accepted Q1–Q3 verdict are preserved on branch
`CDA-68-prototype-child-environment`, commit `b8007bd`, under `packages/tools/prototype/`.

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
- This decision amends ADR 0001 (ADR 0001 §7): Agent Core owns the path-validation step while its
  filesystem code may be injected; `TOOL_INTERNAL_ERROR` is a recoverable error code for unexpected
  tool failures; tool schemas use `typebox` 1.x instead of `@sinclair/typebox` 0.x; and the bash
  input is `timeoutMs`, in milliseconds.
- `CONTEXT-MAP.md` lists `@coding-agent/tools` as its own context, and CDA-20's description names
  all five packages.
- Costs accepted: a fifth package; a rename pass across `packages/ai`; a two-phase tool port that is
  more work than a single `execute`; per-provider capability declarations; and an injected clock
  and ID source that lengthen construction at the composition root.
- `ToolProgress` is shaped with the first tool that reports progress; Agent Core owns and bounds
  it.
- Adding Pi's MIT notice to `packages/ai/src/utils/event-stream.ts`, or rewriting that file, remains
  separate follow-up work (§8).
