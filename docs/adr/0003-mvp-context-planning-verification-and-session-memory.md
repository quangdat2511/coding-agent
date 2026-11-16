# MVP Context, Planning, Verification, and Session Memory

Status: accepted

Date: 2026-09-13 (Amended: 2026-09-16, 2026-11-05, 2026-11-15)

## Context

Ticket [CDA-23](https://datn-fit-hcmus.atlassian.net/browse/CDA-23) defines the minimum runtime behavior for repository context gathering, explicit planning, post-change verification, and in-session memory for the Bun/TypeScript Coding Agent MVP. Earlier architectural decisions established the foundation:

- [ADR 0001: Tool Contracts and Safety Policy](./0001-tool-contracts-and-safety-policy.md) ([CDA-19](https://datn-fit-hcmus.atlassian.net/browse/CDA-19)) standardized tool schemas, sandbox boundaries (`repoRoot`), mutation classifications, and a 40 KiB UTF-8 byte budget for tool outputs.
- [ADR 0002: Agent Session State Machine and Event Protocol](./0002-agent-session-state-machine-and-event-protocol.md) ([CDA-16](https://datn-fit-hcmus.atlassian.net/browse/CDA-16)) defined the 9 lifecycle states, candidate completion detection, and delegated the exact evidence shapes and feedback representations to CDA-23.
- Map Epic [CDA-13](https://datn-fit-hcmus.atlassian.net/browse/CDA-13) ruled out-of-scope all vector databases, RAG/embeddings, cross-session persistent memory, and MCP/LSP integrations for the MVP.

This record establishes the normative behavior, data shapes, and operational policies for context ingestion, planning constraints, verification loop closure, and session memory bounds.

## Decision

### 1. Repository Context Gathering and Project Instructions

The agent runtime minimizes upfront token ingestion while guaranteeing immediate compliance with repository conventions:

- **Discovery and Precedence**: The runtime inspects `repoRoot` for project instructions in this strict precedence order:
  1. `AGENTS.md`
  2. `CLAUDE.md`
  Discovery stops immediately upon finding the first existing file. This eliminates redundant context loading when `CLAUDE.md` is a symlink or mirror of `AGENTS.md`.
- **Byte-Exact Size Cap**: Packaged project instructions are strictly capped at **32 KiB (32,768 UTF-8 bytes)**, inclusive of the truncation marker `\n[...project instructions truncated...]\n`. When raw file content exceeds 32 KiB, the runtime reserves the byte length of the marker (`markerBytes = 40`), truncates the content at the nearest valid UTF-8 code point boundary within `32,768 - markerBytes` bytes, and appends the marker. This guarantees that packaged instructions never exceed 32,768 UTF-8 bytes under any encoding scenario.
- **Prompt Packaging**: Project instructions are wrapped in XML tags within the initial system prompt:
  ```xml
  <project_context>
  <project_instructions path="AGENTS.md">
  {content}
  </project_instructions>
  </project_context>
  ```
- **Environment Metadata**: The initial context supplies execution environment details: working directory (`cwd`), platform, and registered tool snippets.
- **On-Demand Discovery**: Eager scanning of repository trees (e.g. `git ls-files` or recursive directory traversal) is explicitly rejected. All repository structure inspection and source code reading are model-driven via tools (`read` and `bash` with `find`, `ls`, `rg`, `git`).

### 2. Model-Driven Explicit Planning and Scratchpad Conventions

Explicit planning is implemented at the model prompt layer rather than as a state machine expansion:

- **Zero Runtime State Expansion**: `Agent Core` retains the 9 states accepted in ADR 0002; no `planning` state or rigid runtime plan gate is introduced. This preserves seamless execution in both interactive TUI and headless unattended environments (TerminalBench).
- **System Prompt Requirement**: The system prompt enforces explicit planning through instructions:
  > *"Before invoking any mutating tool (`write`, `edit`, `bash`), you must analyze the objective, state your assumptions, and outline a numbered, step-by-step execution plan in your initial response turn."*
- **Transcript Persistence**: The plan is emitted as standard text content within the first `AssistantMessage`. Because the canonical transcript is immutable and included in subsequent Model Turns, the plan remains visible to the model throughout the session without custom state management.
- **Scratchpad Convention**: For complex tasks requiring persistent notes or checklists across multiple turns, the runtime establishes the `.scratch/` directory convention (e.g. `.scratch/plan.md`). The model writes to this directory using the standard `write` tool within `repoRoot`.

### 3. Post-Change Verification Policy and Feedback Loop

When a model turn completes without tool calls, Agent Core detects a `Candidate Completion` and enters the `verifying` state, invoking the injected `VerificationPolicy`:

- **Automated Command Execution and Discriminated Runner Result**: In environments where a verification command is provided (via task configuration, user input, or benchmark harness), the command executes non-interactively in `repoRoot` under standard command timeout constraints. The underlying runner produces a discriminated result:
  ```typescript
  type VerificationRunnerResult =
    | {
        readonly status: "completed";
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr: string;
        readonly durationMs: number;
      }
    | {
        readonly status: "timed_out";
        readonly timeoutMs: number;
        readonly stdout: string;
        readonly stderr: string;
        readonly durationMs: number;
      }
    | {
        readonly status: "launch_failed";
        readonly error: string;
        readonly exitCode?: number; // e.g. 127 for command not found, 126 for non-executable, or shell syntax error
        readonly durationMs: number;
      }
    | {
        readonly status: "cancelled";
        readonly stdout: string;
        readonly stderr: string;
        readonly durationMs: number;
      };
  ```

  The verification policy evaluates the discriminated runner result without overlapping outcomes:
  1. **Byte-Exact Output Budget**: The captured output budget is **40 KiB (40,960 UTF-8 bytes)** applied to combined stdout and stderr. It strictly reuses the dynamic head+tail split algorithm, marker, and valid UTF-8 boundary rules defined in [ADR 0001](./0001-tool-contracts-and-safety-policy.md) before recording evidence or injecting into feedback. Citing ADR-0001 directly avoids duplicating the algorithm formula while preserving both initial test execution context and final assertion failure diagnostics for model self-correction.
  2. **Pass (`status === "completed"` with `exitCode === 0`)**: The policy returns `outcome: "succeeded"`, transitioning the session to `succeeded`.
  3. **Test Assertion Failures (`status === "completed"` with `exitCode !== 0`, excluding launch errors)**: The command ran to completion but test assertions failed. The policy returns `outcome: "continue"`. A structured user message containing the bounded output is injected into the next Model Turn:
     ```text
     [Verification Failed]
     Command: {command}
     Exit code: {exitCode}
     Output:
     {output}
     Please analyze the failure, adjust your changes, and verify again.
     ```
  4. **Execution and System Failures (`status === "timed_out"` or `status === "launch_failed"`)**: The command could not run to normal test completion (binary not found / ENOENT, exit code 127/126, shell syntax error, or command timeout). The policy returns `outcome: "failed"` with `AgentFailureCode: "VERIFICATION_FAILED"`. This immediately halts the session rather than trapping the model in an unrecoverable environment loop.
  5. **Cancellation (`status === "cancelled"`)**: The abort signal ended the run, or had already aborted so nothing started. This is not a decision: Agent Core records the Verification as cancelled ([ADR 0002](./0002-agent-session-state-machine-and-event-protocol.md) §5), and the Verification Policy reports cancellation instead of returning `succeeded`, `continue`, or `failed`. `VerificationDecision` ([ADR 0004](./0004-package-apis-and-dependency-direction.md) §3) has no member for it yet; the type the policy reports it with is decided in [CDA-77](https://datn-fit-hcmus.atlassian.net/browse/CDA-77).

- **Fallback Verification**: If no verification command is configured:
  - Fallback verification is non-gating: it unconditionally returns `outcome: "succeeded"` regardless of `workspaceChanged`, because `CodingTask` defines no field distinguishing read-only from mutating intent.
  - The `workspaceChanged` check is evidence-only: evidence records the observed mutation state as `{ type: "no_command_configured", workspaceChanged: boolean }`. External callers requiring mandatory workspace modifications can evaluate `AgentResult.workspaceChanged` upon session settlement without turning verification into an implicit gate.

- **Evidence Schema**: Every verification outcome records structured evidence conforming to this closed union:
  ```typescript
  type VerificationEvidence =
    | {
        readonly type: "command_execution";
        readonly command: string;
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr: string;
        readonly durationMs: number;
      }
    | {
        readonly type: "command_system_failure";
        readonly command: string;
        readonly failureKind: "timed_out" | "launch_failed";
        readonly message: string;
        readonly exitCode?: number;
        readonly stdout?: string;
        readonly stderr?: string;
        readonly durationMs: number;
      }
    | {
        readonly type: "no_command_configured";
        readonly workspaceChanged: boolean;
      };
  ```

### 4. In-Session Memory and Bounded Limits

Memory management in the MVP is strictly bounded to one in-memory task session:

- **No Dynamic LLM Compaction**: Dynamic summarization turns and rolling message truncation are deferred. In-session memory consists solely of the immutable canonical transcript (messages, tool calls, and tool results).
- **Tool Output Budgets**: Tool results remain strictly capped at 40 KiB UTF-8 bytes per ADR 0001, preventing context explosion from command outputs or file reads.
- **Session Limits Defaults**: Agent Core enforces injected limits at runtime, while ownership of concrete default values belongs to `Coding Agent` configuration per [ADR 0002](./0002-agent-session-state-machine-and-event-protocol.md). For the MVP, `Coding Agent` establishes these standard defaults:
  - `maxModelTurns`: **30**
  - `maxToolCalls`: **100**
  - `maxDurationMs`: **600,000 ms** (10 minutes active execution)
  - `maxConsecutiveRecoverableFailures`: **3**
- **Recoverable Failure Accounting**: `maxConsecutiveRecoverableFailures` bounds consecutive recoverable failures during tool execution. The counter increments for each error Tool Result (including unknown tools, malformed or invalid arguments, schema validation errors, policy violations, Approval denials, and tool runtime failures), resets after a successful Tool Result, and is evaluated sequentially per Tool Result within batched calls. Verification `continue` never increments this counter, as repeated Candidate Completion and Verification cycles are already bounded by `maxModelTurns` and maximum active execution duration per [ADR 0002](./0002-agent-session-state-machine-and-event-protocol.md) §4.
- **Breach Semantics**: When any limit is exhausted, the session terminates immediately in `failed` with code `LIMIT_EXCEEDED`. If any mutating tool was executed prior to exhaustion, `partialChangesPossible` is set to `true`.

### 5. Amendments

On 2026-09-16, the consecutive-failure counter scoping amendment ([CDA-35](https://datn-fit-hcmus.atlassian.net/browse/CDA-35), recorded in [ADR 0004 §3](./0004-package-apis-and-dependency-direction.md)) amended this record:

- **Consecutive-failure counter scope** (§4): stated that the counter increments for each error Tool Result, resets after a successful Tool Result, and is never incremented by a Verification `continue`. The field name `maxConsecutiveRecoverableFailures` remains unchanged.

On 2026-11-05, [CDA-53](https://datn-fit-hcmus.atlassian.net/browse/CDA-53) amended this record:

- **Discovery stop condition** (§1): discovery stops at the first candidate that yields instructions: a regular file with non-whitespace content, or a link whose target is one and passes the Path Jail. A directory, an empty or whitespace-only file, or an unusable link is passed over and reported in `skipped`.
- **Planning requirement** (§2): the sentence names the registered mutating tools instead of a fixed list. With `write`, `edit` and `bash` registered, it is the quoted sentence verbatim.
- **Tool snippets** (§1): the prompt lists the name of each registered tool. Each tool's description and parameters reach the model through its tool definition on every request, so the prompt does not repeat them.

On 2026-11-15, [CDA-74](https://datn-fit-hcmus.atlassian.net/browse/CDA-74) amended this record:

- **Combined output** (§3): the command runs after `exec 2>&1`, as `bash` does (ADR 0001 §7), so
  all of its output is in `stdout`, in the order it was written, and `stderr` is always empty. The
  40 KiB budget applies to that combined output. Two pipes joined by arrival lose the order, and
  splitting the budget between them is not an algorithm ADR 0001 defines.
- **Cancelled runs** (§3): the runner result gains a fourth member,
  `{ status: "cancelled"; stdout; stderr; durationMs }`, for a run the abort signal ended or one
  whose signal had already aborted, in which case nothing starts. A cancelled run is neither a
  finished command nor one that could not start, so neither existing member describes it. Agent
  Core records the Verification as cancelled (ADR 0002 §5,
  [CDA-73](https://datn-fit-hcmus.atlassian.net/browse/CDA-73)); the Verification Policy
  ([CDA-77](https://datn-fit-hcmus.atlassian.net/browse/CDA-77)) reports cancellation rather than a
  decision. §3's union and its list of policy cases include it.
- **Shell syntax errors** (§3): the runner first runs `<shell> -n -c <command>`, which parses the
  command without running any of it, and reports a non-zero result as `launch_failed` with that
  exit code. The command's own exit code cannot show a syntax error, because a failing `make`
  exits 2 as well, and without the check bash runs the lines before the error. A syntax error that
  only appears at run time, inside `eval` or a sourced file, is `completed` with its exit code. A
  check ended by a signal the runner did not send is `launch_failed` naming the signal, without an
  exit code, since it says nothing about the command's syntax.
- **Aborts before a launch** (§3): the runner asks the abort signal again right before each launch,
  because an abort that arrives while it awaits, as while the repository root is checked, reaches
  no listener; and the shared supervisor stops a command whose signal had already aborted when it
  started.
- **Exit codes 126 and 127** (§3): always `launch_failed`, with the exit code, even when a command
  inside a script exits with one. The cost accepted is that a test suite whose last step is a
  missing command ends the Agent Session rather than continuing.
- **A shell ended by a signal the runner did not send** (§3), such as an out-of-memory kill or a
  crash: `completed`, with 128 plus the signal's number as the exit code, as a shell reports such a
  child. The crash is a failure the model may fix, not an environment that cannot run.
- **Other launch failures** (§3): no shell, a repository root that no longer resolves to itself as
  a directory (checked again before each run, as `bash` checks its start directory in `execute`),
  and a shell that cannot be started are `launch_failed` without an exit code. The runner never
  rejects. `launch_failed.error` holds a reason followed by the shell's output, within 40 KiB.
- **Timeout** (§3): each runner is created with a `timeoutMs` within the `bash` bounds of ADR 0001
  §3, 30,000 ms by default and at most 120,000 ms; any other value is `INVALID_CONFIGURATION` when
  the runner is created. The syntax check and the command share that one deadline.

Evidence behind this amendment:

- *Read in source:* the `bash` supervision the runner shares (`packages/tools/src/process-run.ts`),
  and Agent Core's handling of a Verification Policy that throws: the session fails with
  `INTERNAL_ERROR` (`packages/agent-core/src/agent-session.ts`), which is why the runner never
  rejects.
- *Tried locally* (macOS, bash 3.2.57, uid 501): a missing command exits 127, a file with mode 644
  exits 126, `if then` exits 2, `make -f /dev/null nothing` exits 2, and `kill -TERM $$` exits 143.
  `bash -n -c "touch x"` exits 0 and creates nothing; `bash -n -c "if then"` exits 2. `Bun.spawn`
  throws at once with `ENOENT` for a missing shell or start directory and `ENOTDIR` for a file
  used as one. In `oven/bun:1.3.14` as root (bash 5.2.37), a file with mode 644 still exits 126,
  and every runner test passes.
- *Run in CI:* the Windows job (`windows-2025`) passes the runner tests, including the syntax check
  with Git Bash's `-n`; not run on a Windows machine.
- *Not yet run:* a host without bash, such as a minimal Alpine container, where `/bin/sh` is used,
  including its `-n`.
- *Prescriptions:* the four result members, the combined output, the syntax check, the meaning of
  126, 127 and a foreign signal, and the shared deadline are decisions, not observations.

## Consequences

- **Architectural Simplicity**: Keeps `Agent Core` deep and minimal, relying on model prompt capabilities for planning and file conventions for scratchpad notes.
- **Closed Verification Loop**: Provides an automated self-correction loop when tests fail, satisfying the requirements for reproducible TerminalBench evaluation.
- **Context Determinism**: Prevents out-of-memory errors and context overflow through upfront file caps (32 KiB) and per-tool output limits (40 KiB).
- **Deferred Complexity**: Compaction algorithms, vector stores, persistent sessions, and AST indexing remain clean follow-ups once the end-to-end MVP is validated.
