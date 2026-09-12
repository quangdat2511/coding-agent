# Tool Contracts and MVP Safety Policy

Status: accepted

Date: 2026-09-11 (Refined: 2026-09-12)

## Context

Ticket CDA-19 resolves the foundational contracts, execution boundaries, and safety policies for the four core coding tools (`read`, `write`, `edit`, `bash`) in the MVP. Downstream tickets ([CDA-20](https://datn-fit-hcmus.atlassian.net/browse/CDA-20), [CDA-23](https://datn-fit-hcmus.atlassian.net/browse/CDA-23), [CDA-24](https://datn-fit-hcmus.atlassian.net/browse/CDA-24)) depend on these deterministic boundaries to define package APIs, runtime lifecycle loops, and evaluation harnesses.

This record establishes the normative contract, exact error classifications, atomicity invariants, and path sandbox policies required across all packages.

## Decision

We establish the following tool contracts and safety guarantees across the architecture:

### 1. Schema Definition, Validation Seam, and Error Classifications

- Tool parameter schemas are declared using `@sinclair/typebox`. TypeBox schemas are native JSON Schema objects, eliminating translation overhead when providing tool definitions to LLM providers (OpenAI, Anthropic).
- Parameter checking (**Schema Validation**) occurs at the Agent Core boundary prior to tool invocation.
- If model arguments fail Schema Validation, Agent Core intercepts the failure before execution and returns a structured `ToolResult` with `isError: true` and an explicit error code to the model transcript, enabling the model to self-correct in the next turn.
- Error codes are stable identifiers (string union), distinct from the human-readable `message` or the approval `reason`.

#### Normative Tool Contract Table

| Tool | Input Schema | Success Result | Required Failure Cases (`error.code`) |
|---|---|---|---|
| `read` | `{ path: string, offset?: number, limit?: number }` | Numbered text lines (`line \| content`), canonical path, line range metadata | `NOT_FOUND`, `IS_DIRECTORY`, `PATH_OUTSIDE_REPO`, `PERMISSION_DENIED`, `SCHEMA_VIOLATION` (invalid offset/limit) |
| `write` | `{ path: string, content: string }` | Canonical path, bytes written | `PATH_OUTSIDE_REPO`, `PARENT_CREATION_FAILED`, `PERMISSION_DENIED`, `SCHEMA_VIOLATION` |
| `edit` | `{ path: string, targetContent: string, replacementContent: string }` | Canonical path, replacement count (1) | `NO_MATCH`, `AMBIGUOUS_MATCH`, `NOT_FOUND`, `IS_DIRECTORY`, `PATH_OUTSIDE_REPO`, `PERMISSION_DENIED`, `SCHEMA_VIOLATION` |
| `bash` | `{ command: string, timeout?: number, cwd?: string }` | Combined stdout/stderr, exit code (0), duration | `TIMEOUT`, `SIGNAL`, `NON_ZERO_EXIT`, `PATH_OUTSIDE_REPO` (invalid cwd), `APPROVAL_DENIED`, `SCHEMA_VIOLATION` |

### 2. Repository-bound Path Jailing and Symlink Boundaries

All filesystem operations must remain strictly bounded to the active repository root (`repoRoot`):

- **Symlink Invariant**: Symbolic links residing within or pointing outside `repoRoot` are rejected across `read`, `write`, and `edit`. Path traversal attempts (`../`) escaping `repoRoot` are rejected with `PATH_OUTSIDE_REPO`.
- **Existing Paths**: Resolved against `repoRoot` and verified via canonical filesystem paths (`fs.realpath`). If any path component is a symbolic link or canonicalizes outside `repoRoot`, access is denied.
- **New Paths (`write`)**: When writing to a path that does not yet exist:
  1. Find and canonicalize the deepest existing parent directory via `fs.realpath`.
  2. Verify that this deepest existing parent resides strictly inside `repoRoot`.
  3. Create any missing intermediate directory components directly without traversing symlinks.
  4. Perform the temporary file creation and atomic rename strictly within that verified directory.

### 3. Bash Command Execution Bounds and Byte-Exact Budget

- **Timeout**: Default command execution timeout is 30 seconds, with an enforced hard maximum cap of 120 seconds if a custom timeout is requested by the model.
- **Byte-Exact Output Budget**:
  - The returned command `content` is strictly bounded at **40 KiB (40,960 UTF-8 bytes)**, *inclusive* of the truncation marker: `\n[...output truncated...]\n`.
  - When raw output exceeds 40 KiB, head and tail budgets are calculated dynamically from the remaining budget after reserving the UTF-8 byte length of the marker: `headBudget = tailBudget = (40,960 - markerBytes) / 2`.
  - The limit is measured strictly in UTF-8 bytes, not line counts.
- **Execution Mode**: Commands execute in a non-interactive shell environment (`CI=1`, `TERM=dumb`) with `stdin` closed to prevent hanging on interactive prompts or REPLs.

### 4. Mutation Classification, Approval Policy, and Denial

- Tools are categorized by mutation impact:
  - **Read-only**: `read` is automatically approved and executed without user intervention.
  - **Mutating**: `write`, `edit`, and `bash` require explicit approval.
- Agent Core models approval as a first-class lifecycle state (`PENDING_APPROVAL`).
- Agent Core exposes an `ApprovalPolicy` contract:
  - `"ask"` (default): Used by interactive CLI/TUI interfaces, yielding execution to human decision (`ALLOW` or `DENY`).
  - `"auto-approve"`: Used exclusively in isolated execution harnesses (such as automated TerminalBench benchmark runs).
- When a human selects `DENY`, Agent Core returns a `ToolResult` with `isError: true` and `error.code: "APPROVAL_DENIED"`, containing user feedback to allow model adaptation, alongside an explicit emergency session abort option.

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
  | "APPROVAL_DENIED";

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

## Consequences

- **TypeBox adoption**: Packages declaring or validating tools will standardize on `@sinclair/typebox`.
- **Downstream unblocking**:
  - CDA-20 can define clean package boundaries knowing Agent Core owns execution, path validation, and approval states, while AI owns only schema types and raw streaming.
  - CDA-23 can model context budgeting based on the byte-exact 40 KiB output cap and 300-line read defaults.
  - CDA-24 can implement the TerminalBench evaluation runner using `approvalPolicy: "auto-approve"`.
