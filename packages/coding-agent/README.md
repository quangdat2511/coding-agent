# @coding-agent/coding-agent

The composition root: the `coding-agent` executable that turns a command line into an Agent
Session. The command line, exit codes and files written are its external contract
([ADR 0005 §3](../../docs/adr/0005-terminalbench-evaluation-protocol.md)).

## Running a task

`coding-agent run` resolves the configuration, opens one Agent Session, starts the Coding Task from
the task file, and waits for the Agent Result. `runHeadless` in `src/headless.ts` implements this.
`src/cli.ts` parses the arguments and hardens the process first.

| Agent Result | Exit code |
| --- | --- |
| `succeeded` | 0 |
| `failed` | 1 |
| `cancelled` | 130 |

The run prints the final assistant message on standard output. On standard error it prints one
line with the outcome and whether the workspace changed, for example
`coding-agent: succeeded; workspace changed: no`. A failed run adds a second line with the failure
code and message. Both streams are diagnostic only
([ADR 0005 §3](../../docs/adr/0005-terminalbench-evaluation-protocol.md)). A provider error or a
file that the model read can carry the credential, so the run replaces the credential value with
`[redacted]` in everything it prints.

This is the walking skeleton of
[ADR 0006](../../docs/adr/0006-implementation-order-and-mvp-completion-checklist.md) (Join 2).
These parts are still to come:

- The run writes no files yet. CDA-75 (D3.1) adds `run.json`, `events.jsonl` and `result.json`.
- `SIGINT` and `SIGTERM` do not cancel the Agent Session yet, so no run settles `cancelled`.
  CDA-78 (D3.2) adds this.
- `read` is the only registered tool, and Verification is a stand-in. CDA-80 (D5) replaces both.

### Session factory

`openSession` in `src/session-factory.ts` is the one place that builds an Agent Session.
`runHeadless` uses it now, and the interactive entry point will use it too. It builds the Workspace
Resolver, the tool registry, the system prompt and the `ModelPort`, and it supplies the clock and
the identifiers. Two temporary parts are isolated in it:

- It registers `read` only. A run can therefore change no file and start no child process.
- Its Verification Policy is a stand-in that returns a non-gating `succeeded` with
  `no_command_configured` evidence. The stand-in runs no command. If
  `CODING_AGENT_VERIFICATION_COMMAND` is set, the factory opens no Agent Session and the run exits
  70, because skipping the command would report a check that never ran.

When the factory opens no Agent Session, the run removes the output directory it created, as a
configuration error does.

### Named task

`tests/fixtures/named-task/` holds the named fixture task, "add a failing test, then make it pass",
and the fixture repository it runs against. Both are fixed artifacts:
[its README](tests/fixtures/named-task/README.md) says why and gives the rules for changing them.

To run the task against Google on a copy of the fixture repository:

```sh
cp -R packages/coding-agent/tests/fixtures/named-task/repo /tmp/named-task-repo
GOOGLE_API_KEY=... packages/coding-agent/src/cli.ts run \
  --task-file packages/coding-agent/tests/fixtures/named-task/task.md \
  --provider google --model gemini-3.5-flash-lite --approval-policy auto-approve \
  --output-dir /tmp/named-task-out --repo-root /tmp/named-task-repo
```

## Configuring a run

`coding-agent run` takes exactly the flags ADR 0005 §3 lists, and everything else comes from the
environment. No file in the repository or the working directory can configure the agent: the
executable does not autoload `.env` or `bunfig.toml`.

Relative paths in `--task-file`, `--output-dir` and `--repo-root` resolve against the working
directory. `--model` must be listed for `--provider` in the `@coding-agent/ai` provider directory.

### Provider credential

The credential is read only from the selected provider's environment variable, never from a flag,
and is never printed or written.

| `--provider` | Variable, first one set wins |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GOOGLE_API_KEY`, then `GEMINI_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `xai` | `XAI_API_KEY` |

Surrounding whitespace is ignored, and a blank variable counts as unset, so `google` falls back to
`GEMINI_API_KEY` when `GOOGLE_API_KEY` is blank. `@coding-agent/ai` declares these names
(`PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER`), and its provider adapters read them with the same
`readEnvCredential` lookup.

### Verification command

Set `CODING_AGENT_VERIFICATION_COMMAND` to the shell command that checks each Candidate Completion,
for example `bun test`. It runs in the repository root with no Approval, so it is the user's
choice, never the repository's:

- it is not a flag, because ADR 0005 §3 fixes the command line;
- it is not read from a file in the repository, because a repository the agent works on could then
  run a command of its own choosing;
- unset means no command is configured, and Verification is a non-gating success
  ([ADR 0003 §3](../../docs/adr/0003-mvp-context-planning-verification-and-session-memory.md));
- set but blank is a configuration error.

No command runs yet. Until CDA-80 (D5) wires in the Verification Policy, a run with the variable set
exits 70 before its first Model Turn (see [Session factory](#session-factory)).

The interactive path and the end-to-end test configure a command this way. The headless evaluation
path leaves it unset ([ADR 0005 §5](../../docs/adr/0005-terminalbench-evaluation-protocol.md)).

### Session limits

The `default` profile uses the ADR 0003 §4 limits: 30 Model Turns, 100 Tool Calls, 600,000 ms and 3
consecutive recoverable failures, with a 5,000 ms cancellation grace. The grace is long enough for a
tool or Verification child to go from `SIGTERM` to `SIGKILL`, and short enough that a cancelled run
still writes its files inside the 10 s `docker stop` allows. The `terminalbench` profile arrives
with CDA-79 (D3.3). Until then it exits 70 once every configuration check has passed, and removes
any output directory it created.

### Model settings

The sampling settings and the transport retry bound are fixed by the build, not by a flag, and are
the same under every profile. They are bound into the `ModelPort`, so Agent Core never reads them,
and the resolved configuration records them for `run.json`.

- **Max output tokens**: 32,000 for `anthropic`, and the provider's default (the model's full
  output limit) for the others. Anthropic alone requires a cap, and without one `@coding-agent/ai`
  falls back to 4,096 tokens, too few for a large `write`. One cap shared by every provider would
  break models: OpenAI reasoning models reject `max_tokens`, and some models allow fewer tokens
  than others.
- **Temperature**: the provider's default for every provider.
- **Transport retry bound**: 2. `@coding-agent/ai` re-issues a request only before its response
  stream opens ([ADR 0004 §2](../../docs/adr/0004-package-apis-and-dependency-direction.md)), so a
  transient 429 or 5xx at the start of a Model Turn does not end the run.

Agent Core always asks for parallel Tool Calls to be disabled. The `ModelPort` passes that request
to every provider except Google, whose API cannot honour it; Agent Core still accepts a batch.

### System prompt

Every Agent Session starts from one system prompt. `assembleSystemPrompt` in
`src/system-prompt.ts` builds it
([ADR 0003 §1 and §2](../../docs/adr/0003-mvp-context-planning-verification-and-session-memory.md)).
The session factory calls it and passes the prompt to `openAgentSession`. The prompt contains these
parts:

- the planning requirement, which asks for a numbered plan before the first mutating Tool Call
- the Scratchpad convention, which is the `.scratch/` directory in the repository root
- the name of each registered tool
- the working directory, which is the Repository Root, and the platform

The planning requirement names only the mutating tools that are registered. With `write`, `edit`
and `bash` registered, it is the sentence of ADR 0003 §2 word for word. The prompt does not repeat
tool descriptions, because each tool definition gives them to the model on every request.

If the repository has Project Instructions, the prompt also contains them. The Coding Agent looks
for `AGENTS.md` and then `CLAUDE.md` in the Repository Root. It uses the first one that it finds
and does not read the other. It reads nothing else from the repository at startup. The model uses
its tools to read other files on demand.

The Path Jail is the rule that keeps tool paths inside the Repository Root and off symbolic links.
To count as found, a candidate must be a regular file that the `read` tool can open, or a link to
one:

- If the candidate is a symbolic link, the Coding Agent reads the link's target. The target goes
  through the Path Jail like any path from the model. Thus a target outside the repository, or a
  link to another link, is never read.
- If Git cannot create links, it writes each link as a plain file that holds the target path. This
  happens on Windows with `core.symlinks=false`. A candidate of one line, with no newline, that
  names another regular file counts as such a link.
- The `path` attribute in the prompt names the file that the content came from. For a link, it is
  the target.

If a candidate is missing, the Coding Agent tries the next one. If a candidate is a directory, is
empty, or is a link to nothing usable, the Coding Agent also tries the next one. It then adds the
candidate and the reason to the `skipped` list, and the run prints each entry on standard error. If
the file found cannot be read, for example because of its permissions, `assembleSystemPrompt`
returns `INVALID_CONFIGURATION`, and the session factory opens no Agent Session. The CLI exits 2 on
this error, as it does for the configuration errors below.

The packaged instructions are 32,768 UTF-8 bytes at most. A larger file is cut at a character
boundary, and the marker `[...project instructions truncated...]` follows on a line of its own. The
marker counts toward the limit. A file that starts with a UTF-16 byte order mark (the two bytes that
give the byte order) is decoded as UTF-16. Windows PowerShell 5.1 writes files this way. In any
other file, bytes that are not valid UTF-8 become U+FFFD. The instructions go into the prompt inside
these tags:

```xml
<project_context>
<project_instructions path="AGENTS.md">
...
</project_instructions>
</project_context>
```

A `<` in the content that opens or closes one of these tags becomes `&lt;`, so the content cannot
end them early. The escaped form counts toward the limit. The rest of the content stays as it is.

### Configuration errors

Each of these exits 2 before any Agent Session opens, with the reason on standard error:

- a model the provider does not list;
- no credential in the provider's variables (a blank value counts as none);
- a blank `CODING_AGENT_VERIFICATION_COMMAND`;
- a repository root that does not exist, is not a directory, cannot be listed, or is not writable;
- a task file that does not exist, is not a regular file, is larger than 1 MiB, cannot be read, is
  not UTF-8, or is blank;
- an output directory that cannot be created or is not writable;
- Project Instructions that are found but cannot be read (see [System prompt](#system-prompt)).

Checks run in that order and the first problem wins. The output directory is created only once every
other check has passed, and whatever it created is removed again if it then proves unusable, so a
configuration error writes nothing.

## Process hardening

On Linux, the Coding Agent process marks itself non-dumpable as soon as its arguments parse. This
is rule 2 of [ADR 0001 §8](../../docs/adr/0001-tool-contracts-and-safety-policy.md). Right after
argument parsing, `main` in `src/cli.ts` calls `markProcessNonDumpable` from `src/non-dumpable.ts`.
A usage error exits 2 before this step and starts no child. The step comes before configuration
and command dispatch. Thus it precedes every Tool Call and Verification child, on both entry points
and under both Approval Policies. When they load, the modules that `src/cli.ts` imports must not
start a child, because they run before `main`.

Rule 1 of the same section removes the provider credentials from the environment of each `bash`
and Verification child. That removal blocks only the inherited copy. The credential stays in the
`/proc/<pid>/environ` and the memory of the Coding Agent process. A delete inside the process does
not rewrite the environment region that `execve` fixed. A same-user process can read those files
of a dumpable process. A non-dumpable process denies a same-user process without `CAP_SYS_PTRACE`
its `/proc/<pid>/environ`, its `/proc/<pid>/mem` and the links in its `/proc/<pid>/fd`.

The call goes through `bun:ffi` to `prctl(PR_SET_DUMPABLE, SUID_DUMP_DISABLE)` in the C library, and
then reads the flag back with `PR_GET_DUMPABLE`. If either step fails, the Coding Agent starts
nothing and exits 70. The message names the `errno` of a failed `prctl`.

The guarantee has these limits:

- A child with `CAP_SYS_PTRACE` can still read these files, for example root with the full
  capability set on a host.
- A reader with `CAP_SYS_ADMIN` or `CAP_PERFMON` can still open `/proc/<pid>/environ`, but not the
  memory or the fd links. If the ptrace check fails for read access, the kernel accepts these
  capabilities instead (`perfmon_capable()` in `mm_access`). The file belongs to root once the process is
  non-dumpable. Thus such a reader must also be root or hold `CAP_DAC_OVERRIDE` or
  `CAP_DAC_READ_SEARCH`.
- Docker's default capability set has neither `CAP_SYS_ADMIN` nor `CAP_PERFMON`. Thus root in a
  default container gets `EACCES` on all three files. This was tested on Linux 6.18 under WSL2,
  with Docker's default capability set applied through `capsh`.
- A caller with DAC override (permission to bypass file modes), such as root or a holder of
  `CAP_DAC_OVERRIDE` or `CAP_DAC_READ_SEARCH`, can still list the fd numbers in `/proc/<pid>/fd`.
  It cannot follow the links.
- It protects only the Coding Agent process. An ancestor that still holds the credential stays
  readable, for example the shell that exported it. Under `"auto-approve"`, the startup ancestor
  check of CDA-72 will refuse that launch. Under `"ask"`, ADR 0001 §8 accepts this residual.
- A child is dumpable again after its own `execve`, so this call does not protect it. The scrubbed
  environment of rule 1 protects the child instead.
- Only Linux has this control. On macOS, a same-user process can read the startup environment of
  another process through `KERN_PROCARGS2` and `ps`, and macOS has no equivalent of
  `PR_SET_DUMPABLE`. On macOS and Windows the call does nothing, and the guarantee is not claimed.
- A non-dumpable process writes no core dump.

`tests/non-dumpable.test.ts` shows the guarantee on Linux. A same-uid child reads the environment of
a process that is not marked, which proves that the test can see a leak. The same child then gets
`EACCES` on the environment, the memory and the fd links of the Coding Agent process. The test lifts
Yama's `ptrace_scope` 1 for its target. It checks the `mem` result only where dumpability alone
decides it: with no Yama, at scope 0, or at scope 1 once the lift succeeded. This part is skipped on
other platforms. If the tests run with `CAP_SYS_PTRACE`, `CAP_SYS_ADMIN` or `CAP_PERFMON`, it is
also skipped. A reader with one of them can pass at least one of the checks.

On every platform, the same file checks each failure of `markProcessNonDumpable` with a fake C
library. It also preloads `tests/support/fail-hardening.ts` into the executable, which makes the
hardening fail, and checks that the run exits 70 before it resolves the configuration.
