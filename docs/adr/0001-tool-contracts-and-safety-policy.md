# Tool Contracts and MVP Safety Policy

Status: accepted

Date: 2026-09-11 (Refined: 2026-09-12; Amended: 2026-09-13, 2026-11-09, 2026-11-11, 2026-11-12)

## Context

Ticket CDA-19 resolves the foundational contracts, execution boundaries, and safety policies for the four core coding tools (`read`, `write`, `edit`, `bash`) in the MVP. Downstream tickets ([CDA-20](https://datn-fit-hcmus.atlassian.net/browse/CDA-20), [CDA-23](https://datn-fit-hcmus.atlassian.net/browse/CDA-23), [CDA-24](https://datn-fit-hcmus.atlassian.net/browse/CDA-24)) depend on these deterministic boundaries to define package APIs, runtime lifecycle loops, and evaluation harnesses.

This record establishes the normative contract, exact error classifications, atomicity invariants, and path sandbox policies required across all packages.

## Decision

We establish the following tool contracts and safety guarantees across the architecture:

### 1. Schema Definition, Validation Seam, and Error Classifications

- Tool parameter schemas are declared using the `typebox` package (TypeBox 1.x), not the `@sinclair/typebox` 0.x package; `Type`, `TSchema`, and `Static` are imported from `typebox`. TypeBox schemas are native JSON Schema objects, eliminating translation overhead when providing tool definitions to LLM providers (OpenAI, Anthropic).
- Parameter checking (**Schema Validation**) occurs at the Agent Core boundary prior to tool invocation.
- If model arguments fail Schema Validation, Agent Core intercepts the failure before execution and returns a structured `ToolResult` with `isError: true` and an explicit error code to the model transcript, enabling the model to self-correct in the next turn.
- Error codes are stable identifiers (string union), distinct from the human-readable `message` or the approval `reason`.

#### Normative Tool Contract Table

| Tool | Input Schema | Success Result | Required Failure Cases (`error.code`) |
|---|---|---|---|
| `read` | `{ path: string, offset?: number, limit?: number }` | Numbered text lines (`line \| content`), canonical path, line range metadata | `NOT_FOUND`, `IS_DIRECTORY`, `PATH_OUTSIDE_REPO`, `PERMISSION_DENIED`, `SCHEMA_VIOLATION` (invalid offset/limit) |
| `write` | `{ path: string, content: string }` | Canonical path, bytes written | `PATH_OUTSIDE_REPO`, `PARENT_CREATION_FAILED`, `PERMISSION_DENIED`, `SCHEMA_VIOLATION` |
| `edit` | `{ path: string, targetContent: string, replacementContent: string }` | Canonical path, replacement count (1) | `NO_MATCH`, `AMBIGUOUS_MATCH`, `NOT_FOUND`, `IS_DIRECTORY`, `PATH_OUTSIDE_REPO`, `PERMISSION_DENIED`, `SCHEMA_VIOLATION` |
| `bash` | `{ command: string, timeoutMs?: number, cwd?: string }` | Combined stdout/stderr, exit code (0), duration | `TIMEOUT`, `SIGNAL`, `NON_ZERO_EXIT`, `PATH_OUTSIDE_REPO` (invalid cwd), `APPROVAL_DENIED`, `SCHEMA_VIOLATION` |

Any tool may also fail with `TOOL_INTERNAL_ERROR` (§6).

### 2. Repository-bound Path Jailing and Symlink Boundaries

All filesystem operations must remain strictly bounded to the active repository root (`repoRoot`):

- **Symlink Invariant**: Symbolic links residing within or pointing outside `repoRoot` are rejected across `read`, `write`, and `edit`. Path traversal attempts (`../`) escaping `repoRoot` are rejected with `PATH_OUTSIDE_REPO`.
- **Existing Paths**: Resolved against `repoRoot` and verified via canonical filesystem paths (`fs.realpath`). If any path component is a symbolic link or canonicalizes outside `repoRoot`, access is denied.
- **New Paths (`write`)**: When writing to a path that does not yet exist:
  1. Find and canonicalize the deepest existing parent directory via `fs.realpath`.
  2. Verify that this deepest existing parent resides strictly inside `repoRoot`.
  3. Create any missing intermediate directory components directly without traversing symlinks.
  4. Perform the temporary file creation and atomic rename strictly within that verified directory.

Agent Core owns the path-validation step: it decides when validation runs (during preflight, before Approval), what the step guarantees, and how a failure becomes a `ToolResult`. The filesystem code that performs the checks need not live in the Agent Core package; it may be injected through a port, and the [package API decision](./0004-package-apis-and-dependency-direction.md) places it in `@coding-agent/tools`.

### 3. Bash Command Execution Bounds and UTF-8 Output Budget

- **Timeout**: `timeoutMs` is measured in milliseconds, like every other duration field (for example `durationMs`). The default command execution timeout is 30,000 ms (30 seconds), with an enforced hard maximum cap of 120,000 ms (120 seconds) if a custom timeout is requested by the model.
- **UTF-8 Output Budget**:
  - The returned command `content` is strictly bounded at **40 KiB (40,960 UTF-8 bytes)**, *inclusive* of the truncation marker: `\n[...output truncated...]\n`.
  - When raw output exceeds 40 KiB, head and tail budgets are calculated dynamically from the remaining budget after reserving the UTF-8 byte length of the marker: `headBudget = tailBudget = (40,960 - markerBytes) / 2`.
  - The limit is measured strictly in UTF-8 bytes, not line counts.
  - A cut that lands inside a multi-byte character moves to the character boundary, so the returned content can be up to six bytes under the budget, three bytes per end.
- **Execution Mode**: Commands execute in a non-interactive shell environment (`CI=1`, `TERM=dumb`) with `stdin` closed to prevent hanging on interactive prompts or REPLs.

### 4. Mutation Classification, Approval Policy, and Denial

- Tools are categorized by mutation impact:
  - **Read-only**: `read` is automatically approved and executed without user intervention.
  - **Mutating**: `write`, `edit`, and `bash` require explicit approval.
- Agent Core models approval as the first-class `awaiting_approval` lifecycle state. The later
  [Agent Session state-machine decision](./0002-agent-session-state-machine-and-event-protocol.md)
  standardizes the earlier working name `PENDING_APPROVAL`; the behavior is unchanged.
- Agent Core exposes an `ApprovalPolicy` contract:
  - `"ask"` (default): Used by interactive CLI/TUI interfaces, yielding execution to human
    decision (`allow` or `deny`).
  - `"auto-approve"`: Used exclusively in isolated execution harnesses (such as automated TerminalBench benchmark runs).
- When a human selects `deny`, Agent Core returns a `ToolResult` with `isError: true` and
  `error.code: "APPROVAL_DENIED"`, containing user feedback to allow model adaptation, alongside
  an explicit emergency session abort option.

### 5. Partial Changes and Atomicity Invariants

The architecture distinguishes four precise mutation levels:

1. **Pre-execution Rejections (Schema checking, Path Jailing, Approval Denial)**:
   - Strict **Zero mutation** guarantee. No filesystem or process side-effects occur.
2. **Single-File Modifications (`write`, `edit`)**:
   - **Target-File Atomicity**: The target file is never left half-written or corrupted. `write` writes to a temporary file in the destination directory and performs an atomic rename. `edit` strictly requires an exact, unique occurrence of `targetContent`; if missing or matching more than one location, it fails atomically without modifying the file.
   - **Parent Directory Side-Effects**: Creation of missing parent directories (`mkdir -p`) is *not* rolled back if the subsequent file write fails. Empty directories may remain in the repository.
3. **Shell Execution (`bash`)**:
   - **Explicitly Non-Transactional**: Shell execution is unmanaged and cannot be automatically rolled back. A script or command failing mid-execution (e.g., via non-zero exit code, signal, or timeout) may leave partial file changes or side-effects in the repository. Such outcomes are reported with `isError: true` and the corresponding error code (`TIMEOUT` or `NON_ZERO_EXIT`), signaling to the model that partial modifications may exist.

### 6. Normalized Tool Result Interface

Every tool call returns a consistent result shape:

```typescript
type ToolErrorCode =
  | "SCHEMA_VIOLATION"
  | "NOT_FOUND"
  | "IS_DIRECTORY"
  | "PATH_OUTSIDE_REPO"
  | "PERMISSION_DENIED"
  | "NO_MATCH"
  | "AMBIGUOUS_MATCH"
  | "PARENT_CREATION_FAILED"
  | "TIMEOUT"
  | "SIGNAL"
  | "NON_ZERO_EXIT"
  | "APPROVAL_DENIED"
  | "TOOL_INTERNAL_ERROR";

interface ToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  error?: {
    code: ToolErrorCode;
    message: string;
  };
  metadata?: {
    durationMs: number;
    approval?: {
      status: "allowed" | "denied" | "auto_approved";
      decidedBy: "user" | "policy";
      reason?: string;
    };
    truncated?: boolean;
  };
}
```

`TOOL_INTERNAL_ERROR` reports an unexpected failure inside a tool, such as a thrown exception or a rejected promise, that no other code describes. It is recoverable: Agent Core returns it to the model as an error `ToolResult` like any other code, so the model can adapt, and it counts toward the consecutive recoverable Tool Call failure limit. Its `message` is a sanitized summary, never a raw `Error`, stack trace, or mutable reference. A failure caused by an accepted cancellation is recorded as cancelled rather than with this code. If the failure occurs while a mutating tool executes, partial changes may exist, as for any failed mutating call. The name is deliberately distinct from the Agent Session's terminal `INTERNAL_ERROR` failure code.

### 7. Amendments

On 2026-09-13, the [package API decision](./0004-package-apis-and-dependency-direction.md) amended this record:

- **Path-validation ownership** (§2): Agent Core owns the validation step; the filesystem code that performs it may be injected through a port.
- **Unexpected tool failures** (§1, §6): `TOOL_INTERNAL_ERROR` is added as a recoverable error code.
- **Schema package** (§1): `typebox` 1.x replaces `@sinclair/typebox` 0.x.
- **Bash timeout unit** (§1, §3): the input field is `timeoutMs`, measured in milliseconds.

On 2026-09-13, the [credential-isolation decision](https://datn-fit-hcmus.atlassian.net/browse/CDA-29) amended this record:

- **Credential isolation** (§8): a new section constrains how the provider credentials Coding Agent uses may be reached from a process started for a Tool Call or by the Verification Runner — an enforceable contract under `"auto-approve"`, and a bounded, accepted residual under `"ask"`.

On 2026-11-09, [CDA-63](https://datn-fit-hcmus.atlassian.net/browse/CDA-63) amended this record:

- **Shared output budget** (§3): the 40 KiB budget, capped at 40,960 bytes including the marker
  (and up to six bytes less when a cut lands inside a character), is shared by every tool, not only
  `bash`. `read` output is capped with the same marker and head-and-tail split, and the budget
  helper is reusable by `bash` and the Verification Runner. Both ends are kept, so the final error
  survives truncation.

On 2026-11-11, [CDA-110](https://datn-fit-hcmus.atlassian.net/browse/CDA-110) amended this record:

- **Existing paths that `fs.realpath` cannot open** (§2): on macOS and Windows, `fs.realpath` opens
  the path, so it fails for a file this process cannot read and for a socket. For such a final
  component that is not a directory, the resolver canonicalizes its parent with `fs.realpath`,
  requires the component's exact name among the parent's entries, and checks it again with
  `lstat`. A symbolic link swapped in after the walk, or a name that differs from the one on disk
  only in case or as a Windows short name, is still rejected, and readability stays the opening
  tool's check.

On 2026-11-12, [CDA-72](https://datn-fit-hcmus.atlassian.net/browse/CDA-72) amended this record:

- **Startup ancestor check** (§8): besides each ancestor's `/proc/<pid>/environ`, the check reads
  its `/proc/<pid>/cmdline` and refuses an assignment of a non-blank value to a credential
  variable, because every process can read that file. The check passes over an `environ` or
  `cmdline` that is denied with `EACCES` or `EPERM`, because a child is denied it too. The root
  case that the scope of the guarantee excludes is the exception. A walk that cannot finish refuses
  the run with exit 70 instead of 2. Examples are a stat that cannot be read or parsed, an ancestor
  that is hidden rather than gone, and a chain longer than 4,096 processes. If an ancestor exits
  before its stat is read, the walk reads its child's parent field again and goes on from the new
  parent. A PID 1 whose stat cannot be read, as under `hidepid`, ends the chain.
- **Scope of the guarantee** (§8): a Coding Agent that runs as root with `CAP_SETUID` and
  `CAP_SETGID` is excluded, like a child with `CAP_SYS_PTRACE`.

On 2026-11-12, [CDA-30](https://datn-fit-hcmus.atlassian.net/browse/CDA-30) **proposed** this
amendment, which takes effect when its decision is accepted:

- **Credential scope** (§8): [ADR 0007](./0007-evaluation-provider-and-model.md) proposes to
  promote `opencode` to a sixth `--provider` value, with `OPENCODE_API_KEY` joining the fixed set.
  The sentence that placed the OpenCode adapter outside the guarantee is superseded on acceptance;
  the Custom Provider residual is unchanged.

### 8. Credential Isolation for Tool and Verification Processes

Coding Agent authenticates to Model Providers with credentials it reads from its own environment: the provider API-key variables that `@coding-agent/ai` defines. `bash` Tool Calls (§3) and the Verification Runner ([ADR 0003](./0003-mvp-context-planning-verification-and-session-memory.md) §3) start child processes on the model's behalf. Under the `"auto-approve"` policy (§4) with network access these children run unattended, so one that obtains a credential can send it anywhere; even under `"ask"`, a credential copied into a Tool Result enters the transcript, the Session Event log, and any exported trajectory. The credential reaches Coding Agent only because a launching process placed it in the environment Coding Agent inherits, so how the launcher holds it is part of the problem and cannot be fully solved inside Coding Agent. What this section can require therefore depends on the Approval Policy, and the guarantee is stated per policy below rather than as one absolute.

This rule was grounded in Linux experiments (Docker, kernel 6.12, same-uid child): removing the variable from a child's environment blocks only the inherited copy; the credential still sits in a launcher's `/proc/<pid>/environ` and process memory, because an in-process delete does not rewrite the environment region fixed at `execve`. Marking a process non-dumpable denies a same-uid child those files, but only for the process so marked — a still-running ancestor shell that was started with the credential stays readable. See [ADR 0005](./0005-terminalbench-evaluation-protocol.md) for the evidence links.

Two rules hold on every entry point and under both policies:

1. **Non-inheritance.** Every process started for a Tool Call or by the Verification Runner is launched with an environment from which Coding Agent's MVP provider-credential variables are removed. The removed set is exactly `PROVIDER_CREDENTIAL_ENV_VARS`, the six credential variable names `@coding-agent/ai` declares for the five CLI-selectable providers ([ADR 0006](./0006-implementation-order-and-mvp-completion-checklist.md) §3), including providers not selected for the current run. Once [ADR 0007](./0007-evaluation-provider-and-model.md) is accepted, seven names cover six providers. This export is the single source of truth, not an arbitrary denylist. Variables outside that set, such as a task's own `GH_TOKEN`, are not touched, so there is no separate opt-out to misconfigure.
2. **Agent non-recovery.** Because a same-user child can read a launcher's `/proc/<pid>/environ`, `/proc/<pid>/mem`, and `/proc/<pid>/fd`, where the credential remains after an in-process delete, item 1 alone is insufficient. On Linux the Coding Agent process marks itself non-dumpable (`prctl(PR_SET_DUMPABLE, SUID_DUMP_DISABLE)`) before it starts the first Tool Call or Verification child, so a same-uid child without `CAP_SYS_PTRACE` cannot read those files of the Coding Agent process. This closes the Coding Agent process as a vector; it does not affect any other process.

**MVP credential scope and residual (CDA-68, 2026-11-11).** In this section, the provider-credential guarantee covers the fixed MVP set above. OpenCode was outside this set for as long as the CLI could not select it; ADR 0007 proposes to promote the adapter and add `OPENCODE_API_KEY` to the fixed set, and that credential is covered on the same terms as the rest once the decision is accepted. Custom Provider's configurable `apiKeyEnv` is still outside the fixed set and still inherited, and is not covered by the isolation guarantee under either Approval Policy, including `"auto-approve"`. Adding CLI support for a Custom Provider requires extending credential-name discovery and passing the resulting names through the composition root before enabling it, because a fixed static set cannot cover arbitrary names. This clarification preserves CDA-68's accepted MVP scope rather than silently extending it to every AI-library adapter.

**Verification parity.** Verification Runner commands follow every rule in this section identically to `bash`.

**Under `"auto-approve"` (isolated execution harness).** The guarantee is that a Tool Call or Verification child running as the same user, without `CAP_SYS_PTRACE`, cannot obtain a provider credential. Items 1 and 2 are necessary but not sufficient, because the process that launched Coding Agent may itself hold the credential. Two further requirements close that gap:

- **Launch contract.** No same-uid process reachable by a tool child may hold a provider credential in a readable form. The launcher must replace itself with the Coding Agent process (`exec`) rather than remain as a credential-bearing ancestor, must not leave a credential-bearing sibling such as a pipeline stage, and must not write the credential to a file a same-uid process can read. Coding Agent cannot mark or scrub a process it did not start, so this is an obligation on the launcher. [ADR 0005](./0005-terminalbench-evaluation-protocol.md) is the concrete instance for Harbor: the adapter `exec`s the agent and pipes its output nowhere.
- **Startup verification.** Before the composition root opens an Agent Session under `"auto-approve"`, it walks its ancestor chain from its own parent (`/proc/self/stat` field 4, then each `/proc/<pid>/environ`, which it can read because the ancestors are the same user and not hardened) and, if any ancestor still holds one of the provider-credential variables Coding Agent uses, opens no Agent Session and returns a configuration error ([ADR 0002](./0002-agent-session-state-machine-and-event-protocol.md) §1; the headless path maps this to exit code 2, [ADR 0005](./0005-terminalbench-evaluation-protocol.md) §3). This makes the launch contract a checked precondition rather than a trusted one, and on Linux it rejects a launcher that failed to `exec`-replace itself. It walks only the ancestor chain, so a credential-bearing unrelated sibling remains the launcher's responsibility under the launch contract.

**Under `"ask"` (interactive TUI and any attended headless).** The cross-process guarantee above is not claimed, and this section does not require it. The process that launched Coding Agent — typically the user's shell, which exported the provider key — remains a live, dumpable, same-uid ancestor holding the credential, and Coding Agent can neither scrub nor re-mark it. This residual is accepted for the MVP and bounded by two controls already in this ADR: read-only tools (`read`) are jailed to `repoRoot` (§2) and cannot open a `/proc` path, so no auto-approved tool can reach an ancestor's environment; and every mutating `bash` is gated by Approval (§4), so the only tool that can read `/proc` runs only after a human allows that specific command. Requiring interactive users to launch from a credential-free shell, or adding an opt-in hardened launch that delivers the credential to Coding Agent without any ancestor holding it, is deferred; this section states the residual rather than closing it.

**Scope of the guarantee.** Even under `"auto-approve"` the guarantee excludes a child granted `CAP_SYS_PTRACE`, and platforms without a non-dumpable equivalent: on macOS a same-user process can read another's startup environment through `KERN_PROCARGS2` and `ps`, and there is no `PR_SET_DUMPABLE` analogue, so item 2 and the startup ancestor read are Linux-only. It also excludes a Coding Agent that runs as root with `CAP_SETUID` and `CAP_SETGID`. Its child can take the uid and gid of an ancestor of another user, such as the shell behind `sudo -E`. The child can then read the environment of that ancestor, which the startup check passed over because Coding Agent itself was denied it. Reproducible evaluation runs under `"auto-approve"` in Linux containers, where the contract and the check are enforceable.

Enforcement follows the package boundaries in [ADR 0004](./0004-package-apis-and-dependency-direction.md). `@coding-agent/ai` exports the credential variable names as the single source of truth. `@coding-agent/tools`, which implements the `bash` tool and the Verification Runner adapter, builds the scrubbed child environment. `@coding-agent/coding-agent`, the composition root that reads the credentials, applies the non-dumpable hardening, performs the `"auto-approve"` startup ancestor check, and supplies the credential-name set to strip. The Harbor adapter obligations that satisfy the launch contract are fixed by ADR 0005.

An automated test enforces the `"auto-approve"` path: on each backend an evaluation uses, it runs inside a container as the user Harbor runs the agent as and confirms both that a Tool Call cannot recover a credential through inherited environment, `/proc/<pid>/environ`, `/proc/<pid>/mem`, or a credential-bearing ancestor, and that a launcher which does not `exec`-replace itself is rejected by the startup check. ADR 0005 §7 and §9 make that test a precondition for any evaluation job that carries a credential.

## Consequences

- **TypeBox adoption**: Packages declaring or validating tools will standardize on `typebox` (TypeBox 1.x).
- **Downstream unblocking**:
  - CDA-20 can define clean package boundaries knowing Agent Core owns execution, the path-validation step (§2), and approval states, while AI owns only schema types and raw streaming.
  - CDA-23 can model context budgeting based on the 40 KiB output cap measured in UTF-8 bytes and 300-line read defaults.
  - CDA-24 can implement the TerminalBench evaluation runner using `approvalPolicy: "auto-approve"`, once §8's credential isolation is enforced and tested per ADR 0005.
- **Credential isolation cost** (§8): the composition root marks the process non-dumpable through a `prctl` call (via `bun:ffi`) before the first Tool Call or Verification child, `@coding-agent/tools` strips the AI-declared credential variables from every such child, and under `"auto-approve"` the composition root walks its ancestor chain at startup and refuses to run if an ancestor still holds a credential. The full cross-process guarantee is Linux-only and scoped to `"auto-approve"`; under `"ask"` the launching shell may still hold the credential, a residual bounded by the `read` path jail (§2) and by Approval gating of `bash` (§4); a child with `CAP_SYS_PTRACE`, a Coding Agent that runs as root with `CAP_SETUID` and `CAP_SETGID`, and non-Linux platforms are out of scope.
