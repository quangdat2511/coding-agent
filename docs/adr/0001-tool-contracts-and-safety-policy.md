# Tool Contracts and MVP Safety Policy

Status: accepted

Date: 2026-09-11 (Refined: 2026-09-12; Amended: 2026-09-13, 2026-11-09, 2026-11-11, 2026-11-12, 2026-11-22)

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

On 2026-11-12, [CDA-30](https://datn-fit-hcmus.atlassian.net/browse/CDA-30) amended this record:

- **Credential scope** (§8): [ADR 0007](./0007-evaluation-provider-and-model.md) promotes
  `opencode` to a sixth `--provider` value, with `OPENCODE_API_KEY` joining the fixed set in the
  implementation. The sentence that placed the OpenCode adapter outside the guarantee is superseded;
  the Custom Provider residual is unchanged.

On 2026-11-12, [CDA-71](https://datn-fit-hcmus.atlassian.net/browse/CDA-71) amended this record:

- **Shell** (§3): `bash` runs the command as `<shell> -c`, without a login shell or rc files. On
  Linux and macOS the shell is `bash` from `PATH`, or `/bin/sh` without it. On Windows it is Git
  Bash, searched in this order: the Git for Windows install locations under `ProgramFiles`,
  `ProgramFiles(x86)` and `LOCALAPPDATA\Programs`, before anything on `PATH`; then `bin\bash.exe`
  in the install that holds a `git.exe` on `PATH`; then the first `bash.exe` on `PATH` that is not
  WSL's. The `git.exe` step finds Git installed elsewhere with the installer's recommended `PATH`
  option, which adds only `<install>\cmd`: that directory holds `git.exe` but no `bash.exe`. WSL's
  `bash.exe` is never used, because it runs the command in a Linux distribution; it usually comes
  first on `PATH`, so the search goes past it. No shell is a `TOOL_INTERNAL_ERROR`.
- **Combined output** (§1, §3): the command runs after `exec 2>&1`, so its stderr shares stdout's
  pipe and both keep the order they were written in. Joining two pipes by arrival misordered 580
  of 600 alternating lines in the CDA-71 prototype. The cost is that bash reports a syntax error
  one line later than the line in the command.
- **Status line** (§1, §6): Agent Core sends the model only a Tool Result's `content` and
  `isError`, so the content ends with a status line: `[exit code: 0]`, or, for a failure,
  `[exit code: N; partial changes may remain]`, `[timed out after N ms; partial changes may
  remain]` or `[terminated by SIG...; partial changes may remain]`. Its bytes are reserved from
  the 40 KiB budget, so the whole content stays within it. A command that prints nothing shows
  `(no output)`. The partial-changes note appears on every failure, as §5 requires for a failed
  mutating call.
- **Error classification** (§1): `TIMEOUT` is decided by bash's own timer, not by the signal the
  shell died of, since a command can send itself the same signal. `SIGNAL` means the shell itself
  was ended by a signal bash did not send; a killed child of a shell that goes on is a normal
  exit. A cancelled call reports `SIGNAL` with `[cancelled; ...]`. Session cancellation aborts the
  active Tool Call through its signal; once the call quiesces, Agent Core records it as cancelled
  (ADR 0002 §5, [CDA-73](https://datn-fit-hcmus.atlassian.net/browse/CDA-73)).
- **Process lifetime** (§3): a timeout or cancellation sends `SIGTERM` to the command's process
  group and `SIGKILL` 1 s later, so what the command started stops too; on Windows `taskkill /T
  /F`, started through the same launcher, ends the tree at once. Windows therefore has no grace
  period: the command gets no chance to run its own cleanup, and no second step follows, because
  there is no process group left to check. A process the command leaves in the background after
  a normal exit keeps running, so a server started with `&` survives. bash stops reading 200 ms
  after the shell exits, because a background process can keep the pipes open. Its later output
  is lost unless the command redirects it. A process that leaves the group with `setsid` survives
  a timeout; Approval (§4) remains the control for it.
- **Start directory** (§1, §2): `cwd` is relative to `repoRoot` and defaults to it. Every unusable
  start directory is `PATH_OUTSIDE_REPO`, with a message that says why: outside the repository,
  through a symbolic link, missing, or not a directory. It is checked in `prepare` and again before
  the command starts. The start directory is not a jail: the command can change directory, and
  Approval is the control for that.
- **Approval summary** (§4): the summary shows the whole command, unshortened, with its start
  directory when it is not `repoRoot` and its timeout when it is not the default.

The prototypes behind these decisions are preserved on branch `CDA-71-prototype-bash-decisions`,
commit `63ef192`, under `packages/tools/prototypes/` and `packages/agent-core/prototypes/`.

The Windows `git.exe` step is read from the Git for Windows installer's source at commit
`44b6119`, not run on Windows. The `PATH` option the installer marks recommended
([`installer/install.iss` line 2227](https://github.com/git-for-windows/build-extra/blob/44b61193488193e4302afbabf6c7c5caf56c2903/installer/install.iss#L2227))
adds only `<install>\cmd`
([lines 3412–3425](https://github.com/git-for-windows/build-extra/blob/44b61193488193e4302afbabf6c7c5caf56c2903/installer/install.iss#L3412-L3425)),
and the installer puts `bash.exe` in `<install>\bin`
([`installer/release.sh` line 197](https://github.com/git-for-windows/build-extra/blob/44b61193488193e4302afbabf6c7c5caf56c2903/installer/release.sh#L197)).
Unit tests cover the search with a stand-in host, on CI's Windows job too; no test runs it against
a real install made with that option.

On 2026-11-22, [CDA-121](https://datn-fit-hcmus.atlassian.net/browse/CDA-121) amended this record:

- **Capability drop** (§8, rule 2): under `"auto-approve"` on Linux, `coding-agent run` removes
  `CAP_SYS_PTRACE` after it marks itself non-dumpable and runs the startup ancestor check, and before
  it starts the first child. The
  non-dumpable mark does not stop a reader that holds the capability, and root in a Modal sandbox
  holds it (CDA-94, ADR 0005 Evidence). The drop has three steps, all on the thread that starts every
  child:
  1. If the bounding set holds the capability, lower it with `PR_CAPBSET_DROP`, which needs
     `CAP_SETPCAP`. A caller without it gets `EPERM`, and the read-back below decides whether that
     matters.
  2. Clear the capability from the effective, permitted and inheritable sets with `capset`, when one
     of them holds it. The kernel removes it from the ambient set too, because an ambient capability
     must also be permitted and inheritable. With nothing to clear, `capset` is not called, so a
     sandbox that denies it by seccomp does not stop an ordinary user.
  3. Read every set back on the same thread. The run is refused if the capability is still in the
     effective, permitted, inheritable or ambient set, or in the bounding set while the real or
     effective user is root. A child of root gets permitted = bounding | inheritable at `execve`,
     so the bounding set decides what root's child holds; a child of an ordinary user does not.
  The permitted set is cleared as well as the effective set, because a capability left permitted can
  be raised into the effective set again. `PR_SET_NO_NEW_PRIVS` is not set: it cannot be undone and
  it would break `sudo` in every Tool Call, which changes the benchmark's task conditions.
- **Refusal** (§8): a refusal exits 2, as a configuration error that the launcher can correct, for
  example with `docker run --cap-drop SYS_PTRACE`. The message names the capability and the first
  set that still holds it, in the order bounding, effective, permitted, inheritable, ambient. A
  failure of a step exits 70: `capget`, `capset` or `PR_CAPBSET_DROP` fails, or a read-back call
  fails, and the message carries the `errno`; or the C library cannot load, and the message carries
  the loader's own text. The only call whose failure is tolerated is
  `EPERM` from `PR_CAPBSET_DROP`, and the ambient read-back on a kernel before 4.3, which has no
  ambient set and answers `EINVAL`. The interactive path runs under `"ask"`, which §8 exempts, so
  it neither drops nor refuses.
- **Order of the startup checks** (§8, startup verification): the ancestor check runs before the
  capability drop, not after it. The check reads each ancestor's `/proc/<pid>/environ` as Coding
  Agent can, so with the capability still held it also reads a root launcher that holds the
  capability itself. After the drop it reads as a child does, and a launcher that keeps its shell
  and holds the capability could be passed over, because its environment is denied to the reader.
  The check is therefore stricter than the child on purpose: a launcher that a child could not read
  is still refused, which keeps the launch contract a checked precondition and does not depend on
  the sandbox's kernel. The cost is that some launchers are refused that no child could have read.
- **Scope of the guarantee** (§8): under `"auto-approve"` the exclusion of "a child granted
  `CAP_SYS_PTRACE`" narrows to a child that regains the capability after the drop. This happens when
  it runs a setuid-root program or a file with file capabilities, and the bounding set still holds
  the capability: a Coding Agent that runs as an ordinary user cannot lower it. Capabilities belong
  to a thread, so Bun's helper threads keep the capability. They start no child, and the kernel
  refuses a reader whose permitted set is smaller than the target's, so such a thread is harder to
  read than the dropped thread, not easier. Under `"ask"` the exclusion is unchanged.

The evidence is separated into what was read, tried and not yet executed.

**Read.** Linux v6.16 and Bun 1.3.14 (commit `0d9b296`), not run:

- A reader passes the ptrace check when the target's permitted set is a subset of the reader's
  capabilities, or when the reader holds `CAP_SYS_PTRACE`
  ([`security/commoncap.c` L164-L186](https://github.com/torvalds/linux/blob/v6.16/security/commoncap.c#L164-L186)).
- Lowering the bounding set needs `CAP_SETPCAP`
  ([L1268](https://github.com/torvalds/linux/blob/v6.16/security/commoncap.c#L1268)). `capset` may
  only shrink the permitted set and keeps the effective set inside it
  ([L292](https://github.com/torvalds/linux/blob/v6.16/security/commoncap.c#L292),
  [L296](https://github.com/torvalds/linux/blob/v6.16/security/commoncap.c#L296)), and it cuts the
  ambient set to what is still permitted and inheritable
  ([L307](https://github.com/torvalds/linux/blob/v6.16/security/commoncap.c#L307)).
- At `execve`, root's new permitted set is its bounding set combined with its inheritable set
  ([L840-L843](https://github.com/torvalds/linux/blob/v6.16/security/commoncap.c#L840-L843)). With
  `no_new_privs`, an exec cannot gain beyond the old permitted set
  ([L945-L954](https://github.com/torvalds/linux/blob/v6.16/security/commoncap.c#L945-L954)).
- `capget` and `capset` with a header pid of 0 act on the calling thread
  ([`kernel/capability.c` L110](https://github.com/torvalds/linux/blob/v6.16/kernel/capability.c#L110),
  [L233](https://github.com/torvalds/linux/blob/v6.16/kernel/capability.c#L233)).
- `Bun.spawn` calls `spawnProcess` from the binding
  ([`js_bun_spawn_bindings.zig` L621](https://github.com/oven-sh/bun/blob/0d9b296/src/runtime/api/bun/js_bun_spawn_bindings.zig#L621)),
  which on Linux runs `vfork` and `execve` on the calling thread
  ([`bun-spawn.cpp` L156](https://github.com/oven-sh/bun/blob/0d9b296/src/jsc/bindings/bun-spawn.cpp#L156),
  [L303](https://github.com/oven-sh/bun/blob/0d9b296/src/jsc/bindings/bun-spawn.cpp#L303)).

**Tried.** A compiled Bun program, as root, held the key in its environment, marked itself
non-dumpable, applied one of four drops, and started a root `sh` with `Bun.spawnSync` and with
`Bun.spawn`; the child read the program's `environ` and opened its `mem`. The prototype is commit
`c5b47c3` of the branch `prototype/cda-121-drop-ptrace`, which is pushed to the same remote as this
change and is not part of `main`. Its logs are `prototype/cda-121/modal-run.log` (all four variants,
on Modal) and `prototype/cda-121/docker-ptrace-eff-bnd.log` (two variants, in Docker). It ran on
2026-11-22 on Modal (`music-harmony`, `4.19.0-gvisor`) and in Docker Desktop with
`--cap-add=SYS_PTRACE`, which reproduces Modal's root capability locally.

| Drop | Modal | Docker with `SYS_PTRACE` |
| --- | --- | --- |
| none, only the non-dumpable mark | child read `environ`, `mem` opened | same (not in the kept log; see below) |
| `capset` only | denied | **child read `environ`, `mem` opened** |
| bounding set only | denied | denied |
| both | denied | denied (not in the kept log; see below) |

The two Docker rows that the kept log lacks were run by the same prototype, but only the other two
variants were saved. The same two cases are tested in the repository, and the second paragraph below
reports them: the control of `tests/ptrace-capability-proc.test.ts` for "none" and its test of the
Coding Agent after the drop for "both".

On Modal the sandbox sets `NoNewPrivs: 1`, which probably explains why `capset` alone was enough
there, as the `no_new_privs` rule above limits what an `execve` gains; that link was not tested. On
Docker, which does not set it, the child of root took the capability back from the bounding set.
Only the thread that applied the drop changed: the Bun helper threads still showed the capability.

The order of the startup checks comes from two runs of the isolation test's launcher check, which
asks that a launcher that keeps its shell is refused with exit 2. With the ancestor check after the
drop, the artifact built at commit `4fd7393` on Modal (`music-harmony`, root) did not refuse it: the
agent opened a session and exited 1 (`LAUNCHER_NOT_REJECTED`), while all four probe paths passed and
all four controls found the key. The result file is outside the repository, on the author's
machine in `cda121-evidence/isolation-modal-4fd7393-root.json`, and is not yet attached to Jira. The
commit hashes `4fd7393` and `4298d32` in this amendment are those of this branch before it was
rebased onto `main` at `d6499b6`. The rebase changed no file but ADR 0005 and the Isolation Record
of CDA-95, so the sources of the packages that the two artifacts were built from are unchanged.
Reproduced in Docker with the same code
(CLI from source, a shell that exported a disposable key and did not `exec`): the launcher was
refused with exit 2 and the message `ancestor process 1 (sh) holds ANTHROPIC_API_KEY`, both for
root with `--cap-add=SYS_PTRACE` and for Docker's default root. So Docker and Modal differ, and
the launcher check passed in CDA-94's earlier Modal trial, when nothing was dropped (ADR 0005
Evidence). With the ancestor check moved before the drop, the artifact built at commit `4298d32`
(x64 executable SHA-256 `b75c55462f162aea2dda9b8ffd62a3dde9f8f3a4d53c9f5cf9e33876d6632336`, built
from a clean tree) passed the isolation test on Modal on 2026-11-22: root, `music-harmony`,
dataset `terminal-bench/terminal-bench@4.1.0`. No Tool Call found the key. `inherited-environment`
and `ancestors` found nothing, `proc-environ` and `proc-mem` gave `EACCES`, all four controls found
the key, and the launcher that keeps its shell was refused with exit 2 and the expected message,
after no request to the model server. The result file is outside the repository, on the author's
machine in `cda121-evidence/isolation-modal-4298d32-root.json`, and is not yet attached to Jira. This run shows that the change works; it is
not an Isolation Record, which must come from an artifact built at a commit of `main` (ADR 0005 §7,
amendment of CDA-94).

The implementation's tests ran on 2026-11-22 against the real kernel in `oven/bun:1.3.14`
containers as uid 1000, as root, as root with `--cap-add=SYS_PTRACE`, and as uid 1000 with it. Each
run was `bun test` of `tests/ptrace-capability.test.ts`, `tests/ptrace-capability-cli.test.ts`,
`tests/ptrace-capability-proc.test.ts` and `tests/non-dumpable.test.ts` in `packages/coding-agent`,
and each gave 32 passed and 2 skipped. The skipped pair was the proc-access test, which needs root
with the capability, in the three runs that were not root with it, and the pair in
`non-dumpable.test.ts`, which needs the capability absent, in the run as root with it. The output of
these runs was not saved. In
every run the real-libc test read `CapEff`, `CapPrm`, `CapInh` and `CapAmb` (and `CapBnd` for root)
back from `/proc/thread-self/status` and found no capability. With root and `CAP_SYS_PTRACE`, a
control that only marks itself non-dumpable was read through `environ`, `mem` and the fd links, and
the Coding Agent after the drop was denied all three. With the drop disabled in `cli.ts`, that test
failed because the child read the process.

On 2026-11-22, the compiled artifact built from `main` at `e48b12a` passed the isolation test
on Modal as root (`music-harmony`), on Docker as root (`music-harmony`), and on Docker as
UID 10001 (`rs-archive-clone`) for `terminal-bench/terminal-bench@4.1.0`. The
[Isolation Record](../../evaluation/terminalbench/isolation/e48b12ad1758b2016d78c04d76f591cedfdf0098.json)
holds the three passing runs.

The same artifact ran on Modal as UID 1000 on `fp8-rmsnorm-gemm`. No probe found the
disposable credential, and the launcher that kept its shell was refused before any model request.
The result was inconclusive (`MEM_NOT_DEMONSTRABLE`): with `ptrace_scope=1`, the
`proc-mem` control could not find the disposable credential even on the unhardened process.
The Record still needs a passing Modal non-root run under the evidence rule in ADR 0005 §7.

**Not yet executed.**

- Whether `CAP_SYS_PTRACE` was the only cause of the `ancestors` leak in CDA-94. The prototype's
  child walked up to the program that held the key and found no other holder, which suggests that
  the leaking process was Coding Agent itself.
- An ordinary user on a Linux host that keeps the default bounding set was tried only with Docker's
  `--cap-add=SYS_PTRACE`, which puts the capability in the bounding set; no bare-metal host was used.
- musl: `capget` and `capset` were called through the glibc `libc.so.6` only. Whether musl exports
  them was not checked, and the artifact is a glibc build.
- A setuid-root program or a file capability in the child was not tried; the limit above is
  reasoned from the kernel source.
- That a kernel before 4.3 answers `EINVAL` to `PR_CAP_AMBIENT` is taken from `prctl(2)` and was
  not run; a fake kernel tests the branch. A sandbox that answers the ambient read with another
  errno would make the run exit 70; no such sandbox was seen, and gVisor on Modal answers 0 or 1.
- Why Docker refuses the launcher after the drop and Modal does not was not measured. A hypothesis:
  on Linux the check's `readFile` runs on a Bun helper thread that still holds the capability, so it
  reads more than the dropped thread, while on gVisor it reads with the dropped set. That would make
  the check pass over a root launcher that holds the capability. It was not traced.
- Whether a Tool Call child can read such a launcher's environment on Modal after the drop was not
  measured; the isolation test does not measure it, and its `ancestors` probe ran with a launcher
  that had replaced itself with `exec`. Keeping the check before the drop does not depend on the
  answer.

### 8. Credential Isolation for Tool and Verification Processes

Coding Agent authenticates to Model Providers with credentials it reads from its own environment: the provider API-key variables that `@coding-agent/ai` defines. `bash` Tool Calls (§3) and the Verification Runner ([ADR 0003](./0003-mvp-context-planning-verification-and-session-memory.md) §3) start child processes on the model's behalf. Under the `"auto-approve"` policy (§4) with network access these children run unattended, so one that obtains a credential can send it anywhere; even under `"ask"`, a credential copied into a Tool Result enters the transcript, the Session Event log, and any exported trajectory. The credential reaches Coding Agent only because a launching process placed it in the environment Coding Agent inherits, so how the launcher holds it is part of the problem and cannot be fully solved inside Coding Agent. What this section can require therefore depends on the Approval Policy, and the guarantee is stated per policy below rather than as one absolute.

This rule was grounded in Linux experiments (Docker, kernel 6.12, same-uid child): removing the variable from a child's environment blocks only the inherited copy; the credential still sits in a launcher's `/proc/<pid>/environ` and process memory, because an in-process delete does not rewrite the environment region fixed at `execve`. Marking a process non-dumpable denies a same-uid child those files, but only for the process so marked — a still-running ancestor shell that was started with the credential stays readable. See [ADR 0005](./0005-terminalbench-evaluation-protocol.md) for the evidence links.

Two rules hold on every entry point and under both policies:

1. **Non-inheritance.** Every process started for a Tool Call or by the Verification Runner is launched with an environment from which Coding Agent's MVP provider-credential variables are removed. The removed set is exactly `PROVIDER_CREDENTIAL_ENV_VARS`, the names `@coding-agent/ai` exports for the `--provider` values ADR 0005 §3 accepts ([ADR 0006](./0006-implementation-order-and-mvp-completion-checklist.md) §3), including providers not selected for the current run. [ADR 0007](./0007-evaluation-provider-and-model.md) adds `OPENCODE_API_KEY` with the sixth provider, so the export stays the only place the list lives. This export is the single source of truth, not an arbitrary denylist. Variables outside that set, such as a task's own `GH_TOKEN`, are not touched, so there is no separate opt-out to misconfigure.
2. **Agent non-recovery.** Because a same-user child can read a launcher's `/proc/<pid>/environ`, `/proc/<pid>/mem`, and `/proc/<pid>/fd`, where the credential remains after an in-process delete, item 1 alone is insufficient. On Linux the Coding Agent process marks itself non-dumpable (`prctl(PR_SET_DUMPABLE, SUID_DUMP_DISABLE)`) before it starts the first Tool Call or Verification child, so a same-uid child without `CAP_SYS_PTRACE` cannot read those files of the Coding Agent process. This closes the Coding Agent process as a vector; it does not affect any other process. Under `"auto-approve"` on Linux, `coding-agent run` also removes `CAP_SYS_PTRACE` from the thread that starts every child, and refuses to run if it remains (CDA-121, §7), because a child that holds that capability reads a non-dumpable process of the same user.

**MVP credential scope and residual (CDA-68, 2026-11-11).** In this section, the provider-credential guarantee covers the fixed MVP set above. OpenCode was outside this set for as long as the CLI could not select it; ADR 0007 promotes the adapter and adds `OPENCODE_API_KEY` to the fixed set as part of the implementation, and that credential is covered on the same terms as the rest once that lands. Custom Provider's configurable `apiKeyEnv` is still outside the fixed set and still inherited, and is not covered by the isolation guarantee under either Approval Policy, including `"auto-approve"`. Adding CLI support for a Custom Provider requires extending credential-name discovery and passing the resulting names through the composition root before enabling it, because a fixed static set cannot cover arbitrary names. This clarification preserves CDA-68's accepted MVP scope rather than silently extending it to every AI-library adapter.

**Verification parity.** Verification Runner commands follow every rule in this section identically to `bash`.

**Under `"auto-approve"` (isolated execution harness).** The guarantee is that a Tool Call or Verification child running as the same user, without `CAP_SYS_PTRACE` (which Coding Agent removes from itself under this policy, §7), cannot obtain a provider credential. Items 1 and 2 are necessary but not sufficient, because the process that launched Coding Agent may itself hold the credential. Two further requirements close that gap:

- **Launch contract.** No same-uid process reachable by a tool child may hold a provider credential in a readable form. The launcher must replace itself with the Coding Agent process (`exec`) rather than remain as a credential-bearing ancestor, must not leave a credential-bearing sibling such as a pipeline stage, and must not write the credential to a file a same-uid process can read. Coding Agent cannot mark or scrub a process it did not start, so this is an obligation on the launcher. [ADR 0005](./0005-terminalbench-evaluation-protocol.md) is the concrete instance for Harbor: the adapter `exec`s the agent and pipes its output nowhere.
- **Startup verification.** Before the composition root opens an Agent Session under `"auto-approve"`, it walks its ancestor chain from its own parent (`/proc/self/stat` field 4, then each `/proc/<pid>/environ`, which it can read because the ancestors are the same user and not hardened) and, if any ancestor still holds one of the provider-credential variables Coding Agent uses, opens no Agent Session and returns a configuration error ([ADR 0002](./0002-agent-session-state-machine-and-event-protocol.md) §1; the headless path maps this to exit code 2, [ADR 0005](./0005-terminalbench-evaluation-protocol.md) §3). The check runs before Coding Agent drops `CAP_SYS_PTRACE` (§7, CDA-121), so that it reads as strongly as the process can and is stricter than the child. This makes the launch contract a checked precondition rather than a trusted one, and on Linux it rejects a launcher that failed to `exec`-replace itself. It walks only the ancestor chain, so a credential-bearing unrelated sibling remains the launcher's responsibility under the launch contract.

**Under `"ask"` (interactive TUI and any attended headless).** The cross-process guarantee above is not claimed, and this section does not require it. The process that launched Coding Agent — typically the user's shell, which exported the provider key — remains a live, dumpable, same-uid ancestor holding the credential, and Coding Agent can neither scrub nor re-mark it. This residual is accepted for the MVP and bounded by two controls already in this ADR: read-only tools (`read`) are jailed to `repoRoot` (§2) and cannot open a `/proc` path, so no auto-approved tool can reach an ancestor's environment; and every mutating `bash` is gated by Approval (§4), so the only tool that can read `/proc` runs only after a human allows that specific command. Requiring interactive users to launch from a credential-free shell, or adding an opt-in hardened launch that delivers the credential to Coding Agent without any ancestor holding it, is deferred; this section states the residual rather than closing it.

**Scope of the guarantee.** Even under `"auto-approve"` the guarantee excludes a child that regains `CAP_SYS_PTRACE` after Coding Agent removed it (§7, CDA-121), for example through a setuid-root program, and platforms without a non-dumpable equivalent: on macOS a same-user process can read another's startup environment through `KERN_PROCARGS2` and `ps`, and there is no `PR_SET_DUMPABLE` analogue, so item 2 and the startup ancestor read are Linux-only. It also excludes a Coding Agent that runs as root with `CAP_SETUID` and `CAP_SETGID`. Its child can take the uid and gid of an ancestor of another user, such as the shell behind `sudo -E`. The child can then read the environment of that ancestor, which the startup check passed over because Coding Agent itself was denied it. Reproducible evaluation runs under `"auto-approve"` in Linux containers, where the contract and the check are enforceable.

Enforcement follows the package boundaries in [ADR 0004](./0004-package-apis-and-dependency-direction.md). `@coding-agent/ai` exports the credential variable names as the single source of truth. `@coding-agent/tools`, which implements the `bash` tool and the Verification Runner adapter, builds the scrubbed child environment. `@coding-agent/coding-agent`, the composition root that reads the credentials, applies the non-dumpable hardening, performs the `"auto-approve"` startup ancestor check, and supplies the credential-name set to strip. The Harbor adapter obligations that satisfy the launch contract are fixed by ADR 0005.

An automated test enforces the `"auto-approve"` path: on each backend an evaluation uses, it runs inside a container as the user Harbor runs the agent as and confirms both that a Tool Call cannot recover a credential through inherited environment, `/proc/<pid>/environ`, `/proc/<pid>/mem`, or a credential-bearing ancestor, and that a launcher which does not `exec`-replace itself is rejected by the startup check. ADR 0005 §7 and §9 make that test a precondition for any evaluation job that carries a credential.

## Consequences

- **TypeBox adoption**: Packages declaring or validating tools will standardize on `typebox` (TypeBox 1.x).
- **Downstream unblocking**:
  - CDA-20 can define clean package boundaries knowing Agent Core owns execution, the path-validation step (§2), and approval states, while AI owns only schema types and raw streaming.
  - CDA-23 can model context budgeting based on the 40 KiB output cap measured in UTF-8 bytes and 300-line read defaults.
  - CDA-24 can implement the TerminalBench evaluation runner using `approvalPolicy: "auto-approve"`, once §8's credential isolation is enforced and tested per ADR 0005.
- **Credential isolation cost** (§8): the composition root marks the process non-dumpable through a `prctl` call (via `bun:ffi`) before the first Tool Call or Verification child, and under `"auto-approve"` also removes `CAP_SYS_PTRACE` from the thread that starts them (CDA-121, §7), `@coding-agent/tools` strips the AI-declared credential variables from every such child, and under `"auto-approve"` the composition root walks its ancestor chain at startup and refuses to run if an ancestor still holds a credential. The full cross-process guarantee is Linux-only and scoped to `"auto-approve"`; under `"ask"` the launching shell may still hold the credential, a residual bounded by the `read` path jail (§2) and by Approval gating of `bash` (§4); a child that regains `CAP_SYS_PTRACE`, a Coding Agent that runs as root with `CAP_SETUID` and `CAP_SETGID`, and non-Linux platforms are out of scope.
