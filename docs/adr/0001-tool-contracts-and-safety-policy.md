# Tool Contracts and MVP Safety Policy

Status: accepted

Date: 2026-09-11

## Context

Ticket CDA-19 resolves the foundational contracts, execution boundaries, and safety policies for the four core coding tools (`read`, `write`, `edit`, `bash`) in the MVP. Downstream tickets ([CDA-20](https://datn-fit-hcmus.atlassian.net/browse/CDA-20), [CDA-23](https://datn-fit-hcmus.atlassian.net/browse/CDA-23), [CDA-24](https://datn-fit-hcmus.atlassian.net/browse/CDA-24)) depend on these deterministic boundaries to define package APIs, runtime lifecycle loops, and evaluation harnesses.

## Decision

We establish the following tool contracts and safety guarantees across the architecture:

1. **Schema Definition & Validation Seam**:
   - Tool parameter schemas are declared using `@sinclair/typebox`. TypeBox schemas are native JSON Schema objects, eliminating translation overhead when providing tool definitions to LLM providers (OpenAI, Anthropic).
   - Parameter validation occurs at the Agent Core boundary before tool invocation.
   - If model arguments fail validation, Agent Core intercepts the failure and returns a structured `Tool Result` with `isError: true` to the model transcript, enabling the model to self-correct in the next turn.

2. **Repository-bound Path Jailing & Symlink Boundaries**:
   - All file tools (`read`, `write`, `edit`) are strictly jailed within the active repository root (`repoRoot`).
   - Paths are resolved against `repoRoot` and verified via canonical filesystem paths (`fs.realpath`).
   - Path traversal attempts (`../`) and symbolic links resolving outside `repoRoot` are rejected atomically with a safety violation error. Neither read nor write access outside `repoRoot` is permitted.

3. **Bash Command Execution Bounds**:
   - Default command execution timeout is 30 seconds, with an enforced hard maximum cap of 120 seconds if a custom timeout is requested by the model.
   - Combined stdout/stderr output is bounded at 40KB (~1,000 lines). Excess output is truncated using a Head + Tail strategy (retaining the first 20KB and last 20KB with an explicit `[...output truncated...]` marker).
   - Commands execute in a non-interactive shell environment (`CI=1`, `TERM=dumb`) with `stdin` closed to prevent unbounded blocking on REPLs or interactive prompts.

4. **First-Class Approval and Mutation Classification**:
   - Tools are categorized by mutation impact:
     - **Read-only**: `read` is automatically approved and executed without user intervention.
     - **Mutating**: `write`, `edit`, and `bash` require explicit approval.
   - Agent Core models approval as a first-class lifecycle state (`PENDING_APPROVAL`).
   - Agent Core exposes an `ApprovalPolicy` contract:
     - `"ask"` (default): Used by interactive CLI/TUI interfaces, yielding execution to human decision (`ALLOW` or `DENY`).
     - `"auto-approve"`: Used exclusively in isolated/headless execution harnesses (such as automated TerminalBench benchmark runs).
   - When a human selects `DENY`, Agent Core returns a `Tool Result` with `isError: true` containing user feedback to allow model adaptation, alongside an explicit emergency session abort capability.

5. **Atomicity and Integrity Guarantees**:
   - `read`: Accepts `{ path: string, offset?: number, limit?: number }`. Defaults to returning at most 300 lines with 1-indexed line numbers (`line | content`) when no limit is provided.
   - `write`: Accepts `{ path: string, content: string }`. Automatically ensures parent directory creation (`mkdir -p`). Writes atomically via temporary file and rename to prevent corrupted or partial file states.
   - `edit`: Accepts `{ path: string, targetContent: string, replacementContent: string }`. Strictly enforces exact unique matching; if `targetContent` is missing or matches multiple locations in the file, the tool fails atomically without applying partial changes.
   - `bash`: Accepts `{ command: string, timeout?: number, cwd?: string }`. Any specified `cwd` must resolve strictly within `repoRoot`.

6. **Normalized Tool Result Interface**:
   - Every tool call returns a consistent result shape:
     ```typescript
     interface ToolResult {
       toolCallId: string;
       toolName: string;
       content: string;
       isError: boolean;
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
  - CDA-23 can model context budgeting based on the 40KB output cap and 300-line read defaults.
  - CDA-24 can implement the TerminalBench evaluation runner using `approvalPolicy: "auto-approve"`.
