# Pi architecture research

## Snapshot and scope

Research snapshot: **2026-09-05**. The Pi repository tip used here is
[`9841914c71a74d81abe07f751aefd271fd924e63`](https://github.com/earendil-works/pi/commit/9841914c71a74d81abe07f751aefd271fd924e63),
the `main` commit titled `fix(tui): keep list selection unchanged on mouse hover`, dated
2026-09-05 in the repository history. Package metadata at this commit reports version
`0.85.0` for the main Pi packages, including the four packages in scope; for example, see
[`packages/ai/package.json`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/package.json),
[`packages/agent/package.json`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/package.json),
[`packages/tui/package.json`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/tui/package.json), and
[`packages/coding-agent/package.json`](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/package.json).

This note uses only Pi's repository source, repository documentation, and package metadata.
The comparison target is this repository's four-context map: AI, Agent Core, Terminal UI, and
Coding Agent. The resulting recommendations are design guidance for the MVP, not a proposal to
take Pi packages as dependencies or to copy their APIs.

## Executive finding

Pi is a deliberately compositional stack. `pi-ai` owns provider/model normalization and streaming;
`pi-agent-core` owns the model/tool loop, state, and lifecycle events; `pi-tui` owns terminal
rendering primitives and has no dependency on the agent or model layers; and `pi-coding-agent`
composes those layers into a CLI, tools, sessions, extensions, and interactive/print/RPC modes.
Pi's README describes these roles explicitly and also lists the package family around them
([README package overview](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/README.md#L10-L30)).

The most useful MVP reference is the set of seams, not the whole implementation: a provider-neutral
streaming model interface, a small stateful agent loop, schema-validated tools, typed lifecycle
events, and an application-owned event-to-TUI adapter. The largest deliberate redesign should be
Safety: Pi does not provide a built-in permission system, while this project treats Safety and
Approval as controlled architecture concerns. Pi's own README says that it runs with the launching
process's permissions and recommends an external sandbox/container boundary when stronger isolation
is needed ([README safety note](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/README.md#L30-L38)).

## 1. Package boundaries and responsibilities

### Four packages in scope

| Pi package | Responsibility and boundary | What it should mean for this MVP |
| --- | --- | --- |
| `@earendil-works/pi-ai` | A unified, provider-independent LLM API. Its root exports message/context/tool types, model lookup, authentication helpers, event streams, and validation; provider factories and API implementations are separate subpaths. The root intentionally avoids generated catalogs, provider factories, and the legacy global compatibility layer ([root exports and boundary](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/index.ts#L4-L48)). | Own `Model`, `Context`, `Message`, `Tool`, streaming events, and provider adapters. Keep provider-specific HTTP/auth details behind this package. |
| `@earendil-works/pi-agent-core` | General-purpose agent runtime. The lightweight `Agent`/`agentLoop` owns transcript state, the turn loop, model calls, tool validation/execution, queues, abort handling, and lifecycle events. The same package currently also exports a newer durable `AgentHarness`/`AgentLane` surface with sessions, operations, recovery, hooks, and snapshots ([current root surface](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/index.ts#L41-L80)). | Own Agent Session/control flow and state transitions. For the MVP, use the lightweight loop shape as the reference and keep the durable harness as a later evolution unless durability is a demonstrated requirement. |
| `@earendil-works/pi-tui` | A terminal UI library: components, containers, editor/list/markdown/scroll primitives, key handling, terminal abstractions, screen modes, and differential rendering. Its package metadata has no dependency on `pi-ai`, `pi-agent-core`, or `pi-coding-agent`, and its public root exports the UI seams ([package metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/tui/package.json), [public exports](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/tui/src/index.ts#L1-L145)). | Keep rendering/control presentation independent from runtime and provider code. The Coding Agent should translate domain events into TUI updates. |
| `@earendil-works/pi-coding-agent` | The user-facing CLI/application. It composes `pi-ai`, `pi-agent-core`, and `pi-tui`, supplies coding tools and extensions, manages sessions/settings/resources, and exposes interactive, print, RPC, and client-facing entry points. Its metadata identifies the `pi` binary and the three core package dependencies ([package metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/package.json)). | Own product policy, tool registration, Coding Task input, session wiring, approvals, Verification orchestration, result formatting, and exit policy. |

An important implementation detail is that the current Pi coding-agent SDK still builds the
default path around the lightweight `Agent`: it imports `Agent` from agent-core, provides a
provider-agnostic fallback stream function, and then constructs an `AgentSession`
([SDK imports and fallback](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/sdk.ts#L1-L37),
[session construction](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/sdk.ts#L256-L410)).
The durable harness is therefore a current adjacent architecture, not something to silently
assume is the interactive CLI's only execution path.

### Important adjacent packages

| Package | Current role | Relevance to the map |
| --- | --- | --- |
| `@earendil-works/chord` | Application-composition runtime for services, replicated state, RPC, and plugins ([metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/chord/package.json)). | Infrastructure under the newer durable harness and remote/application composition; not part of the minimal AI/TUI seam. |
| `@earendil-works/pi-telemetry` | Vendor-neutral telemetry contracts and typed schemas, deliberately without a backend/exporter/global span ([metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/telemetry/package.json)). | Cross-cutting observability seam for AI and runtime; keep it optional and explicit in the MVP. |
| `@earendil-works/pi-protocol` and `@earendil-works/pi-client` | Transport-neutral CBOR protocol and client for remote Pi sessions ([protocol metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/protocol/package.json), [client metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/client/package.json)). | Remote execution is a separate seam; do not make it a prerequisite for the local MVP. |
| `@earendil-works/pi-server` | Experimental local server for a durable session/agent harness ([metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/server/package.json)). | Evidence that Pi is growing a durable/remote architecture around agent-core, but outside the four-package MVP boundary. |
| `@earendil-works/pi-session-backend-sqlite-node` | Node SQLite session backend for agent-core ([metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/session-backends/sqlite-node/package.json)). | A persistence adapter seam; useful later if Agent Session durability becomes a requirement. |
| `@earendil-works/pi-evals` | Private evaluation package with AI/coding-agent development dependencies ([metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/evals/package.json)). | Test/evaluation infrastructure, not runtime architecture. |

## 2. Public interfaces, seams, and dependency direction

### Dependency direction

The package metadata gives the core direction:

```text
pi-ai  ───────────────► pi-agent-core  ───────────────► pi-coding-agent
  ▲                         ▲       ▲                        │
  │                         │       │                        │
  └─────────────────────────┴───────┴──────────── pi-tui ◄───┘
```

More precisely, `pi-agent-core` depends on `pi-ai`; `pi-coding-agent` depends on `pi-ai`,
`pi-agent-core`, and `pi-tui`; `pi-tui` does not depend upward on the runtime. The coding-agent
application is the composition root. Chord and telemetry are adjacent infrastructure dependencies
in the current package graph ([agent metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/package.json),
[coding-agent metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/package.json),
[TUI metadata](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/tui/package.json)).

### `pi-ai`: model and provider seams

The provider seam is `Provider`: a provider owns identity, authentication/model discovery,
optional refresh, and `stream`/`streamSimple` implementations. `Models` is the collection-level
facade that resolves a model, obtains auth, routes the request to its provider, and exposes
`stream`, `complete`, and simple variants ([Provider interface](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/models.ts#L88-L149),
[Models interface](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/models.ts#L151-L228),
[dispatch and factory](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/models.ts#L641-L709)).

The request contract is provider-neutral: a `Context` contains an optional system prompt,
messages, and tools; a `Tool` has a name, description, and TypeBox parameter schema
([context and tool types](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/types.ts#L517-L528)).
The uniform provider stream returns an `AssistantMessageEventStream`; all provider API modules
expose the same stream shape, while provider-specific differences stay behind the adapter
([stream seam](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/types.ts#L264-L337)).

The event protocol separates stream start, text/thinking/tool-call deltas, final `done`, and
`error` events. A final assistant message carries the normalized content, tool calls, usage,
stop reason, and error information ([assistant stream events](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/types.ts#L530-L562)).
This is a strong seam for the MVP because the agent loop can consume incremental model output
without knowing whether the provider is OpenAI, Anthropic, Google, or another supported API; the
supported API union and provider IDs are explicit but extensible ([API/model types](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/types.ts#L17-L80),
[model shape](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/types.ts#L842-L872)).

### `pi-agent-core`: loop, state, and tool seams

The lightweight runtime separates the loop from provider details. `AgentOptions` receives a
`streamFn`, `convertToLlm`, context transformation, model/transport settings, queue policy,
and tool hooks ([AgentOptions](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent.ts#L97-L123)).
The loop works in the broader `AgentMessage` domain and converts to provider `Message` only at
the LLM boundary ([loop boundary](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L1-L4)).

The public tool contract is explicit: a tool declares a TypeBox parameter schema and an
`execute(toolCallId, params, signal, onUpdate)` function; execution returns a normalized result
and may report progress or throw on failure. Tool calls expose their ID, name, and arguments
([AgentTool and result](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/types.ts#L361-L412)).
Before execution, the loop finds the tool, prepares and validates arguments, and invokes the
`beforeToolCall` hook. A hook can block execution; after execution, `afterToolCall` can observe or
override the result ([preflight and execution](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L607-L718),
[post-processing and tool-result event](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L720-L803)).

`AgentState` is the transcript/control state: system prompt, model, thinking level, tools,
messages, streaming message, pending tool calls, and error message. The runtime emits
`agent_start/end`, `turn_start/end`, `message_start/update/end`, and
`tool_execution_start/update/end` events ([state and events](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/types.ts#L321-L446)).
The stateful `Agent` wrapper owns the transcript, lifecycle, queues, abort/wait behavior, and
listener ordering ([Agent wrapper](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent.ts#L167-L178),
[event processing](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent.ts#L240-L253)).

The loop can execute multiple calls in parallel by default, while a tool or configuration can
request sequential execution ([tool execution mode](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L406-L424),
[parallel/sequential paths](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L487-L560)).

The newer durable seam is `AgentHarness` → `AgentLane`: a lane accepts prompts/skills/templates,
drives operations, handles abort/inspect/retry/compaction/navigation, and exposes a session
snapshot/watch interface. The harness also has explicit `before_tool` and `after_tool` hooks and
typed durable events ([harness public surface](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/harness/agent-harness.ts#L518-L622),
[harness operations/events](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/harness/agent-harness.ts#L111-L186)).
It is a useful future reference for recovery and durability, but it substantially expands the
MVP surface.

### `pi-coding-agent`: application/session seams

`createAgentSession` is the composition seam. It loads settings/resources, chooses active tools,
creates the agent with a provider-neutral stream callback, wires model payload/response hooks,
and returns an `AgentSession` ([session factory](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/sdk.ts#L173-L193),
[tool/model/runtime wiring](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/sdk.ts#L256-L372)).

`AgentSession` is the application-facing wrapper shared by run modes. It adds persistence,
extensions, compaction/retry, model/thinking settings, bash/session operations, and maps agent
events into session events ([session responsibilities](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts#L1-L14),
[session event types](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts#L143-L230)).
It persists completed custom/LLM messages on message completion and flushes turn-level work on
turn completion ([persistence/event handling](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts#L642-L723)).

## 3. Minimal end-to-end control flow

The following is the smallest faithful flow for the **default lightweight Agent path** at this
commit. It is a control-flow model, not a claim that every Pi mode shares exactly the same UI.

```text
Coding Task
    │ user input
    ▼
pi-coding-agent interactive/print mode
    │ session.prompt(...)
    ▼
AgentSession: commands/skills/input hooks, model/auth/session setup
    │ Agent.prompt / Agent.continue
    ▼
pi-agent-core agent loop
    │ convertToLlm + transformContext
    ▼
pi-ai Models/modelRuntime → provider stream
    │ assistant stream events
    ▼
Agent state + lifecycle events
    │ assistant tool calls
    ▼
validate → Approval seam → tool.execute(...)
    │                         │ progress/result
    └─────────────── tool result message ◄──────────┘
                            │
                            ▼
                  next model turn or settled result
                            │
             ┌──────────────┴──────────────┐
             ▼                             ▼
       AgentSession persistence       InteractiveMode
             │                         event → component/TUI
             └──────────────┬──────────────┘
                            ▼
                 agent_end / agent_settled
                            │
                     result + exit policy
```

1. **Accept the Coding Task.** Interactive mode waits for user input and calls
   `session.prompt(userInput)`. During streaming, new input can be steered or queued according
   to the session's streaming behavior; command/skill/template processing occurs at the session
   boundary ([interactive input loop](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1108-L1141),
   [prompt orchestration](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts#L1150-L1317)).

2. **Start a model turn.** `AgentSession` invokes `Agent.prompt` (or `continue` for a follow-up),
   the loop snapshots/derives context, applies `transformContext`, converts agent messages to
   LLM messages, and calls the configured stream function ([prompt/continuation loop](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts#L1105-L1148),
   [stream-to-LLM boundary](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L275-L370)).

3. **Consume model interaction.** The stream emits incremental text/thinking/tool-call updates.
   The loop replaces the partial assistant message as updates arrive, emits message lifecycle
   events, and ends with a normalized assistant message or error ([loop event handling](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L275-L370)).

4. **Handle Tool Calls and Approval.** For each model tool call, agent-core resolves the named
   tool, validates its arguments against the schema, then invokes `beforeToolCall`; a blocked call
   becomes a tool error result and is not executed ([tool preflight](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L607-L675)).
   In current Pi, this is an extension hook rather than a built-in permission policy: the coding
   agent installs an extension `tool_call` hook, whose result can block/terminate, and extensions
   can separately ask the UI for confirmation ([extension tool-call event](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/extensions/types.ts#L889-L954),
   [block result](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/extensions/types.ts#L1125-L1134),
   [hook installation](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts#L478-L540),
   [extension UI confirmation seam](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/extensions/types.ts#L130-L147)).

5. **Execute the tool.** An allowed tool receives its call ID, validated arguments, an
   `AbortSignal`, and an update callback. The loop emits tool start/update/end events, catches
   failures into a normalized result, invokes the after-tool hook, and appends the tool result to
   the conversation ([execution and progress](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L677-L803)).
   The loop then either starts another model turn, handles steering/follow-up work, or settles;
   errors and aborts are represented in the assistant result and lifecycle events ([main loop](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L156-L273)).

6. **Update state and persist events.** Agent state is updated from the event stream and listeners
   are awaited in registration order. `AgentSession` forwards events to extensions/listeners and
   persists completed messages/turn work, so the session transcript is not just a UI projection
   ([state reducer/event processing](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent.ts#L537-L591),
   [session persistence](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts#L642-L723)).

7. **Render the TUI.** The interactive mode subscribes to session events. It creates/updates
   assistant and tool components for message/tool start/update/end events, updates progress and
   queue indicators, and requests renders; the renderer itself is composed from `pi-tui` screen,
   terminal, and component primitives ([interactive event-to-UI mapping](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3165-L3384),
   [TUI composition seam](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/modes/interactive/tui-renderer.ts#L1-L78)).
   This keeps the TUI from knowing how a model or tool works.

8. **Return/exit.** A completed run produces `agent_end` and then `agent_settled`; interactive
   shutdown stops the TUI, disposes the runtime, prints the resume information when applicable,
   and exits with success or failure according to the shutdown path ([interactive shutdown](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3946-L4031)).
   `main.ts` selects interactive versus print/RPC modes and applies the mode's exit behavior
   ([mode selection](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/main.ts#L119-L130),
   [mode startup/exit handling](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/main.ts#L1052-L1095)).

### Durable-harness variant

Pi's current agent-core also exposes a different control model: a caller submits work to an
`AgentLane`, the harness records operation/session state, drives the lane, and exposes durable
events and snapshots. The harness documentation describes immutable entry trees, mutable values,
an authoritative operation state, and recovery-oriented operation boundaries
([harness documentation](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/docs/harness.md),
[harness events/watch](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/harness/events.ts#L7-L84)).
This variant is relevant when CDA needs resumability, remote control, or multiple lanes; it should
not be conflated with the default `AgentSession` path above.

## 4. MVP decisions: adopt as reference vs deliberately redesign

### Adopt or use as a reference

- **Provider-neutral model boundary.** Copy the architectural idea of `Context`, normalized
  messages, `Tool`, `Models`, and a provider-owned streaming adapter. This directly supports the
  project's multi-provider goal while making providers replaceable
  ([Pi AI contracts](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/types.ts#L517-L562),
  [provider dispatch](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/ai/src/models.ts#L88-L149)).

- **One explicit model-to-agent seam.** Keep provider conversion and context transformation at the
  LLM boundary. This permits pruning/injection and future Context Intelligence without making the
  agent loop provider-specific ([AgentOptions boundary](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent.ts#L97-L123)).

- **Schema-first Tool Calls.** Use a stable tool name/description/schema plus validated arguments,
  call IDs, cancellation, progress, and normalized results. This gives Safety and Verification a
  reliable pre/post seam ([AgentTool contract](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/types.ts#L361-L412)).

- **Typed streaming/lifecycle events.** Model deltas and runtime lifecycle events should be
  explicit and ordered. The TUI, persistence, telemetry, and tests should consume those events
  rather than reach into provider or tool implementations ([agent events](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/types.ts#L414-L446)).

- **Application-owned event-to-view adapter.** Keep `pi-tui` primitives ignorant of the agent;
  let Coding Agent map state/events to assistant, tool, progress, queue, and error components
  ([interactive mapping](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3165-L3384)).

- **Small core plus extensions.** Use hooks for provider payload customization and optional product
  behavior, but keep the core loop and tool contract stable. Pi's session wrapper demonstrates the
  value of keeping persistence, retry, compaction, and extension handling around the loop rather
  than embedding every feature in it ([session wrapper](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/agent-session.ts#L1-L14)).

### Deliberately redesign for this project

- **Make Approval a first-class control, not an optional hook.** Pi's `beforeToolCall` can block,
  but the default design does not define an approval record, policy, user decision, timeout,
  audit trail, or durable “waiting for approval” state; Pi explicitly has no built-in permission
  system ([Pi safety statement](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/README.md#L30-L38),
  [Pi hook shape](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/coding-agent/src/core/extensions/types.ts#L889-L954)).
  CDA should model `Tool Call → Approval request → allow/deny/modify → execute` explicitly, with
  no execution before an allow decision. The Approval should be visible to the TUI and recorded
  in Agent Session state.

- **Add Verification as an explicit postcondition.** Pi's lightweight loop has pre-tool hooks and
  after-tool hooks, but no general project-level Verification stage in the default path (this is an
  architectural inference from the loop/session surfaces above). CDA should make verification
  evidence and pass/fail state explicit after state-changing tools, rather than treating a tool's
  returned text as proof that the Coding Task is complete.

- **Keep the MVP's four contexts sharper than Pi's current package family.** Do not pull Chord,
  remote protocol/client/server, durable lanes, SQLite backends, and full resource/extension
  machinery into the first implementation. They are valid later seams, but their current package
  metadata and harness surface show a much larger architecture than the four-context map needs
  ([adjacent package family](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/README.md#L21-L38),
  [durable harness surface](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/harness/agent-harness.ts#L518-L622)).

- **Prefer deterministic sequential execution initially.** Pi supports parallel tool execution and
  preserves tool-result ordering separately from completion ordering
  ([parallel execution](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/src/agent-loop.ts#L487-L560)).
  For a first Safety/Approval/Verification implementation, sequential execution makes approval
  state, filesystem effects, and verification evidence easier to reason about. Add concurrency only
  behind an explicit execution policy once the state model is proven.

- **Keep persistence minimal and authoritative.** Start with a small Agent Session transcript plus
  explicit runtime state and event log. Adopt the durable harness's separation between transcript,
  operation state, and observation as a future direction, but do not reproduce its transaction,
  lane, recovery, and replicated-state machinery before the MVP needs resumable remote work
  ([harness documentation](https://github.com/earendil-works/pi/blob/9841914c71a74d81abe07f751aefd271fd924e63/packages/agent/docs/harness.md)).

- **Centralize result and exit policy in Coding Agent.** Pi has multiple run modes and mode-specific
  shutdown behavior. CDA should expose a small `AgentResult`/exit mapping from the composition root
  so interactive rendering, print mode, and tests agree on success, denial, tool failure, model
  failure, cancellation, and verification failure.

## Bottom line for CDA-14

Use Pi as the reference for **direction and seams**: AI is below Agent Core, TUI is independent,
and Coding Agent composes them. Reuse the conceptual contracts for normalized model streaming,
schema-validated tools, cancellation/progress, stateful turns, and typed events. Redesign the
control points Pi leaves to application policy—especially Approval, Safety boundaries, Verification,
and the final result/exit contract—and keep the first implementation below the durable/remote
harness scale.

