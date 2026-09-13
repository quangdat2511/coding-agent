# Tool Contracts and MVP Safety Policy

Status: accepted

Date: 2026-09-11 (Refined: 2026-09-12; Amended: 2026-09-13)

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

### 3. Bash Command Execution Bounds and Byte-Exact Budget

- **Timeout**: `timeoutMs` is measured in milliseconds, like every other duration field (for example `durationMs`). The default command execution timeout is 30,000 ms (30 seconds), with an enforced hard maximum cap of 120,000 ms (120 seconds) if a custom timeout is requested by the model.
- **Byte-Exact Output Budget**:
  - The returned command `content` is strictly bounded at **40 KiB (40,960 UTF-8 bytes)**, *inclusive* of the truncation marker: `\n[...output truncated...]\n`.
  - When raw output exceeds 40 KiB, head and tail budgets are calculated dynamically from the remaining budget after reserving the UTF-8 byte length of the marker: `headBudget = tailBudget = (40,960 - markerBytes) / 2`.
  - The limit is measured strictly in UTF-8 bytes, not line counts.
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

- **Credential isolation** (§8): a new section requires that the provider credentials Coding Agent uses be unreachable from any process started for a Tool Call or by the Verification Runner.

### 8. Credential Isolation for Tool and Verification Processes

Coding Agent authenticates to Model Providers with credentials it reads from its own environment: the provider API-key variables that `@coding-agent/ai` defines. `bash` Tool Calls (§3) and the Verification Runner ([ADR 0003](./0003-mvp-context-planning-verification-and-session-memory.md) §3) start child processes on the model's behalf. Under the `"auto-approve"` policy (§4) with network access these children run unattended, so one that obtains a credential can send it anywhere; even under `"ask"`, a credential copied into a Tool Result enters the transcript, the Session Event log, and any exported trajectory. The credentials Coding Agent uses must therefore be unreachable from any such process.

This rule was grounded in Linux experiments (Docker, kernel 6.12, same-uid child): removing the variable from a child's environment blocks only the inherited copy; the credential still sits in the launcher's `/proc/<pid>/environ` and process memory, because an in-process delete does not rewrite the environment region fixed at `execve`. Marking the launcher non-dumpable is what denies a same-uid child those files. See [ADR 0005](./0005-terminalbench-evaluation-protocol.md) for the evidence links.

The rule is normative:

1. **Non-inheritance.** Every process started for a Tool Call or by the Verification Runner is launched with an environment from which Coding Agent's provider-credential variables are removed. The removed set is exactly the credential variable names `@coding-agent/ai` declares for its providers, which is the single source of truth, not an arbitrary denylist. Variables the task or user set in the environment, such as a task's own `GH_TOKEN`, are not touched: only the keys Coding Agent itself uses are stripped, so there is no separate opt-out to misconfigure.
2. **Non-recovery.** Because a same-user child can read the launcher's `/proc/<pid>/environ`, `/proc/<pid>/mem`, and `/proc/<pid>/fd`, where the credential remains after an in-process delete, item 1 alone is insufficient. On Linux the Coding Agent process marks itself non-dumpable (`prctl(PR_SET_DUMPABLE, SUID_DUMP_DISABLE)`) before it starts the first Tool Call or Verification child, so a same-uid child without `CAP_SYS_PTRACE` cannot read those files.
3. **No credential-bearing relative.** The credential must not persist in any other live process reachable by a tool child, such as a parent shell that was launched with the credential or a pipeline sibling, and must not be written to a file a same-uid process can read. A credential held only inside the non-dumpable Coding Agent process satisfies this; a launcher that leaves a credential-bearing shell alive as an ancestor or sibling of the tool child does not.
4. **Verification parity.** Verification Runner commands follow items 1 to 3 identically to `bash`.
5. **Scope of the guarantee.** The guarantee is that a Tool Call or Verification child running as the same user, without `CAP_SYS_PTRACE`, cannot obtain the credentials. It does not defend against a child granted `CAP_SYS_PTRACE`, nor against a platform without a non-dumpable equivalent: on macOS a same-user process can read another's startup environment through `KERN_PROCARGS2` and `ps`, and there is no `PR_SET_DUMPABLE` analogue, so item 2 is Linux-only. Reproducible evaluation runs under `"auto-approve"` in Linux containers, where the full guarantee holds; the interactive path gates every mutating command behind Approval (§4), and its macOS residual is accepted and documented rather than closed in this MVP.

Enforcement follows the package boundaries in [ADR 0004](./0004-package-apis-and-dependency-direction.md). `@coding-agent/ai` exports the credential variable names as the single source of truth. `@coding-agent/tools`, which implements the `bash` tool and the Verification Runner adapter, builds the scrubbed child environment. `@coding-agent/coding-agent`, the composition root that reads the credentials, applies the non-dumpable hardening and supplies the credential-name set to strip. The evaluation adapter obligations that keep item 3 true under Harbor — execute the agent in place so the credential-bearing launcher shell is replaced, and use no output pipeline that retains the credential in a sibling — are fixed by ADR 0005.

An automated test enforces the rule: on each backend an evaluation uses, it runs inside a container as the user Harbor runs the agent as and confirms a Tool Call cannot recover a credential through inherited environment, `/proc/<pid>/environ`, `/proc/<pid>/mem`, or a credential-bearing ancestor or sibling. ADR 0005 §7 and §9 make that test a precondition for any evaluation job that carries a credential.

## Consequences

- **TypeBox adoption**: Packages declaring or validating tools will standardize on `typebox` (TypeBox 1.x).
- **Downstream unblocking**:
  - CDA-20 can define clean package boundaries knowing Agent Core owns execution, the path-validation step (§2), and approval states, while AI owns only schema types and raw streaming.
  - CDA-23 can model context budgeting based on the byte-exact 40 KiB output cap and 300-line read defaults.
  - CDA-24 can implement the TerminalBench evaluation runner using `approvalPolicy: "auto-approve"`, once §8's credential isolation is enforced and tested per ADR 0005.
- **Credential isolation cost** (§8): the composition root marks the process non-dumpable through a `prctl` call (via `bun:ffi`) before the first Tool Call or Verification child, and `@coding-agent/tools` strips the AI-declared credential variables from every such child. The guarantee is Linux-only; the interactive macOS path keeps a documented residual, and a child with `CAP_SYS_PTRACE` is out of scope.
