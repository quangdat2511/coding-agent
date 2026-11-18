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

A run that opens no Agent Session exits 2 on a usage or configuration error. An internal error
outside the Agent Session exits 70. A run that exits 0, 1 or 130 has written the three files of
[Files written](#files-written).

The run prints the final assistant message on standard output. On standard error it prints one
line with the outcome and whether the workspace changed, for example
`coding-agent: succeeded; workspace changed: no`. A failed run adds a second line with the failure
code and message. Both streams are diagnostic only
([ADR 0005 §3](../../docs/adr/0005-terminalbench-evaluation-protocol.md)), so a write that fails,
for example because the reader of a pipe has gone, does not change the exit code. A provider error or a
file that the model read can carry the credential, so the run replaces the credential value with
`[redacted]` in everything it prints.

## Version

`coding-agent --version` prints `coding-agent <version> <commit>` on standard output and exits 0.
The version comes from `package.json`. The commit is the one that the artifact build defines. A
run from source has no commit and prints `coding-agent <version> (no commit)`. The Harbor adapter
compares this line with `artifact-manifest.json` before each trial
([ADR 0005 §6](../../docs/adr/0005-terminalbench-evaluation-protocol.md)). `--version` must be the
only argument. After `run`, it is an unknown flag.

`bun run build:artifact` builds the evaluation executables and their manifest. The procedure is in
[Evaluation artifact build](../../scripts/README.md#evaluation-artifact-build).

This is the walking skeleton of
[ADR 0006](../../docs/adr/0006-implementation-order-and-mvp-completion-checklist.md) (Join 2).
These parts are still to come:

- `read` is the only registered tool, and Verification is a stand-in. CDA-80 (D5) replaces both.
- Agent Core enforces `maxModelTurns`, `maxToolCalls`, `maxDurationMs`, and
  `maxConsecutiveRecoverableFailures`. Exhaustion emits `runtime_limit_reached` and settles with
  `LIMIT_EXCEEDED`. Active duration counts model streaming, Tool Call execution, and Verification;
  it excludes `ready` and human time in `awaiting_approval`, and aborts an active effect on expiry.

### Cancelling a run

Once `src/cli.ts` listens for them, `SIGINT` and `SIGTERM` cancel the run and do not end the
process. `src/cli.ts` turns either one into an abort of the `signal` it gives `runHeadless`, and
`runHeadless` dispatches the `cancel` command, the only cancellation path of
[ADR 0004 §3](../../docs/adr/0004-package-apis-and-dependency-direction.md). The signal's name
becomes the cancellation reason in the Agent Result.

- A run whose active work quiesces within the Cancellation Grace Period settles `cancelled` and
  exits 130, with the three files written. The Agent Result reports `workspaceChanged` and
  `partialChangesPossible`.
- A signal that arrives before the Coding Task starts cancels the Agent Session in place of
  starting it. The run makes no Model Turn and still exits 130 with the three files.
- A run whose active work ignores the cancellation past the grace period settles `failed` with
  `CANCELLATION_TIMEOUT` and exits 1, with the three files written.
- Only the first signal cancels. A later one changes nothing while the Agent Session is cancelling
  or writing `result.json`.
- `src/cli.ts` listens for the signals from just before the ancestor check until `runHeadless`
  returns. A signal before the Agent Session opens cancels it as soon as it opens; a second one
  before then ends the process by that signal, so a run stuck in configuration can still be
  stopped. A signal outside that window ends the process in the default way.

Work that outlived the Agent Result, such as a Model Turn that ignored the cancellation, would
hold the process open. So on every path `src/cli.ts` waits until what it printed has been written
and then calls `process.exit`.

On Windows, sending a signal to another process ends it at once and runs no handler. The tests
that send a signal to the executable are therefore skipped there, and Ctrl+C in a Windows console
is untested. The in-process tests of `runHeadless` cover the exit 130 path and
`CANCELLATION_TIMEOUT` on every platform.

### Files written

A run writes three files into `--output-dir`
([ADR 0005 §4](../../docs/adr/0005-terminalbench-evaluation-protocol.md)). An evaluator reads the
outcome from `result.json`, rebuilds the trajectory from `events.jsonl`, and reproduces the run
from `run.json`. It does not need standard output. `src/run-files.ts` writes all three, and each
carries `"schemaVersion": 1`.

**`run.json`** is written before the Coding Task starts. It is one JSON object with these fields:

| Field | Content |
| --- | --- |
| `codingAgent` | `version` and `commit`. The commit is `null` in a run from source. The artifact build (`bun run build:artifact`) sets it with `bun build --define CODING_AGENT_COMMIT='"<commit>"'` |
| `provider`, `model` | the `--provider` and `--model` values |
| `sampling` | `maxOutputTokens` and `temperature`. `null` means the provider's default |
| `transportRetryBound` | how often `@coding-agent/ai` re-issues a request before its stream opens |
| `repoRoot` | the canonical Repository Root |
| `profile`, `limits` | the Evaluation Profile and its resolved Session Limits |
| `approvalPolicy` | the Approval Policy |
| `verification` | `command`, or `null` when no command is configured |
| `tools` | the name of each registered tool |
| `systemPrompt` | the assembled system prompt |

**`events.jsonl`** holds one Session Event on each line, in the envelope of
[ADR 0002](../../docs/adr/0002-agent-session-state-machine-and-event-protocol.md) with
`schemaVersion` added. The run appends each line when the event arrives. It leaves out
`assistant_content_delta`, `tool_execution_progress` and `verification_progress`, because the
completion events carry the final message, the Tool Result and the evidence. The other events keep
their `sequence`, so a gap in the numbers marks the events that were left out.

The Agent Session never waits for the log. A killed process can therefore lose the last events. A
log is complete only if its last line is a `session_settled` event. A reader must treat any other
log as truncated, and must not take its last event as the outcome of the run. Each line is written
when its event arrives, so a reader can also catch a line half written, during a run or after a
kill. Only a line that ends in a newline is a whole event, and a reader ignores the text after the
last newline.

**`result.json`** is written after the Agent Session settles and the log has written its last
event. It holds `exitCode`, `result` (the Agent Result) and `finishedAt` (the time the run received
the Agent Result, in ISO 8601).

A `MODEL_FAILURE` carries `details` with `phase` (`request`, `stream` or `finish`), `reason`, and
optionally `rawReason` and `httpStatus`. `httpStatus` is the provider's HTTP status when a response
failed the request; after the SDK's transport retries it is the last attempt's. ADR 0005 §7 reruns a
trial whose `httpStatus` is 401, 403, 429 or 5xx. The `openai`, `openrouter`, `xai` and `opencode`
providers record it; `anthropic` and `google` do not, so their failures are never rerun-eligible on
this condition. A Custom Provider records it when its `variant` is `chat_completions` and does not
when it is `messages`. An error that a provider sends after it answered HTTP 200 has no `httpStatus`
either, because the SDK raises it without one. Only a request refused before the stream opened
carries one.

```json
{
  "exitCode": 1,
  "result": {
    "outcome": "failed",
    "failure": {
      "code": "MODEL_FAILURE",
      "message": "the model request failed: 429 Rate limit exceeded for this window",
      "details": { "phase": "request", "reason": "error", "httpStatus": 429 }
    }
  }
}
```

These rules apply to all three files:

- The credential value is never written. Each string and each property name goes through the same
  replacement as the printed text, so the value appears as `[redacted]`.
- When the output directory holds files of an earlier run, the run removes the old `result.json`
  before it writes `run.json`, and it empties `events.jsonl`. It does this once the Agent Session
  is open. A run that is refused before that point, with exit code 2 or 70, leaves the directory as
  it was, so the files of the earlier run stay.
- `run.json` and `result.json` are each written to `<name>.partial` and renamed into place, so a
  reader finds the whole document or none. A killed run can leave a `.partial` file, which a reader
  ignores.
- When a file cannot be written, the run exits 70. A failure before the Coding Task starts ends
  the run before its first Model Turn, and the run removes the `run.json` and `events.jsonl` it
  wrote. A failure in the log during the task shows only after the session settles. The run then
  still writes `result.json`, with `exitCode` 70, and the log has no `session_settled`, so a reader
  treats it as truncated. A failure to write `result.json` leaves none. Either way the run still
  prints the final message and the outcome.

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

### Recorded provider responses in tests

The tests run the executable against recorded provider responses, and the command line of
ADR 0005 §3 has no flag for that. The injection uses Bun, not Coding Agent:

- A test starts the bin entry as `bun --preload tests/support/replay-provider.ts src/cli.ts run ...`,
  with the two Bun flags of the shebang before `--preload`. The arguments after the bin entry are
  exactly the ADR 0005 §3 command line.
- The preloaded module replaces `globalThis.fetch`, which every provider adapter sends through. It
  answers each request with the next file named in `CODING_AGENT_TEST_REPLAY_FIXTURES`, a
  comma-separated list of paths below `tests/fixtures/`.
- Nothing in `src/` knows about fixtures. The shipped executable has no test hook, no base URL
  setting and no variable that can redirect a credential.

A `BUN_OPTIONS` variable would remove even the Bun flag. It was rejected, because its quoting is
fragile. Bun 1.3.14 silently skips a quoted preload path that contains a space, and only a
backslash before the space loads it. A skipped preload would send the test's request to the real
provider.

## Configuring a run

`coding-agent run` takes exactly the flags ADR 0005 §3 lists, and everything else comes from the
environment. No file in the repository or the working directory can configure the agent: the
executable does not autoload `.env` or `bunfig.toml`.

On Linux and macOS the `coding-agent` bin entry does this through its shebang,
`bun --no-env-file --config=/dev/null`. On Windows, run the executable compiled with the ADR 0005 §2
autoload flags (`bun build src/cli.ts --compile --no-compile-autoload-dotenv
--no-compile-autoload-bunfig`). The bin entry cannot start there, because Bun's Windows bin shim
does not understand `env -S`, and Bun 1.3.14 on Windows accepts no empty device as `--config`
(`/dev/null` fails to open and `NUL` crashes Bun). A `bun src/cli.ts` run there loads a
`bunfig.toml` preload from the working directory.

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
| `opencode` | `OPENCODE_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `xai` | `XAI_API_KEY` |

Surrounding whitespace is ignored, and a blank variable counts as unset, so `google` falls back to
`GEMINI_API_KEY` when `GOOGLE_API_KEY` is blank. `@coding-agent/ai` declares these names
(`PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER`), and its provider adapters read them with the same
`readEnvCredential` lookup.

`opencode` is OpenCode's Go subscription gateway (ADR 0007), not its Zen plan. Each request names
the client with a `coding-agent/<version>` user agent, and every request of one Agent Session
carries the same `x-opencode-session` header, which is what lets the gateway reuse its prompt
cache.

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
still writes its files inside the 10 s `docker stop` allows.

The `terminalbench` profile uses the ADR 0005 §5 limits: 250 Model Turns, 1,000 Tool Calls,
3,600,000 ms and 10 consecutive recoverable failures. Its cancellation grace is the same as in
`default`. A profile changes only these limits. The system prompt, Project Instructions discovery, the
Scratchpad convention, the tools and the model settings are the same under both profiles. The values
live in `SESSION_LIMITS_BY_PROFILE` in `src/run-config.ts`, so a build fixes them, and no flag or
environment variable changes them. `run.json` records the profile name and its resolved limits.

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

The [ancestor check](#ancestor-check) runs before all of these. When it finds a credential in an
ancestor process, it also exits 2 and writes nothing.

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
  readable, for example the shell that exported it. The [ancestor check](#ancestor-check) refuses
  that launch under `"auto-approve"`. It finds a credential in the environment or the arguments of
  an ancestor. It cannot see a credential that an ancestor set after it started. Under `"ask"`, ADR 0001 §8 accepts this residual.
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

## Ancestor check

This check applies under `"auto-approve"` on Linux. If a process above the Coding Agent still
holds a provider credential, the Coding Agent refuses to run. This is the startup check of
[ADR 0001 §8](../../docs/adr/0001-tool-contracts-and-safety-policy.md). A launcher that starts the
Coding Agent as a child keeps the credential in its own `/proc/<pid>/environ`. A Tool Call child
runs as the same user, so it can read that file. Coding Agent cannot scrub or mark a process that
it did not start. The launcher must replace itself with the Coding Agent through `exec`, and this
check makes that rule a checked precondition.

`main` in `src/cli.ts` calls `checkAncestorCredentials` from `src/ancestor-credentials.ts` right
after the hardening step and before it resolves the configuration. The check reads the parent from
field 4 of `/proc/self/stat`. For each ancestor up to the end of the chain, it reads
`/proc/<pid>/environ` and `/proc/<pid>/cmdline`. Then it reads the stat again and goes on to that
ancestor's parent. The credential variables are all the names in `PROVIDER_CREDENTIAL_ENV_VARS`
from `@coding-agent/ai`, not only those of the chosen provider. In the environment, a blank value
counts as none, by the rule of `readEnvCredential`. In the arguments, an assignment such as
`ANTHROPIC_API_KEY=sk-...` counts, because every process can read `/proc/<pid>/cmdline`.

The check has these outcomes:

- If an ancestor holds a credential, the run exits 2 and writes nothing. The message names the
  process ID, the process name and the variable, but never the value. The name is shown as UTF-8,
  and its control characters are escaped.
- If the environment of an ancestor is denied with `EACCES` or `EPERM`, the check goes on to the
  parent of that ancestor. A root-owned `init` and a non-dumpable process are examples. A Tool
  Call child has the same user and capabilities as the Coding Agent, so the child is usually denied
  the same file. Root is the exception, as the limits below say.
- If an ancestor exits after its first stat read, the check goes on to the parent from that read.
  The second stat read finds this case: the process is gone, or its start time (field 22) changed
  because another process reused the pid. The files read in between then do not count.
- If an ancestor exits before its stat is read, the kernel gives its child a new parent. The check
  reads the parent field of the child again and goes on from the new parent.
- If the stat of PID 1 cannot be read, the chain ends there. With `hidepid=invisible`, a user who
  is not root cannot see the `init` of root. No process is above PID 1.
- If the stat of another ancestor cannot be read, and the parent field of its child still names
  it, the run exits 70. `hidepid` causes this case for a process of another user, for example the
  `sshd` of root above an SSH session. The processes above it can still hold the credential, and
  the walk cannot find them. Run the Coding Agent where `/proc` has no `hidepid`, or as a user who
  can see that process.
- If `/proc/self/stat` cannot be read, or another read fails, the run exits 70. The check fails
  closed, because it cannot show that no ancestor holds a credential.

The check has these limits:

- It does not run under `"ask"`. ADR 0001 §8 accepts the residual there: the shell that exported
  the key stays a readable ancestor. Two controls bound that residual. The `read` tool is jailed to
  the Repository Root, so it cannot open a `/proc` path. Every mutating `bash` call waits for an
  Approval, so a human allows each command that can read `/proc`.
- It does not run on macOS or Windows. On those platforms `"auto-approve"` has no protection
  against an ancestor that holds a credential. On macOS a same-user process can read the startup
  environment of another process through `KERN_PROCARGS2` and `ps`. Run unattended evaluations
  under `"auto-approve"` in a Linux container, as ADR 0005 does.
- It walks only the ancestor chain. A sibling that holds the credential, such as another stage of
  a pipeline, stays the launcher's responsibility.
- It sees only the environment that `execve` gave each ancestor, and the arguments. An ancestor
  that set the variable after it started keeps it only in its memory. Examples are a shell where
  you typed `export ANTHROPIC_API_KEY=...`, and a Python launcher that sets `os.environ` and then
  calls `subprocess.run`. The check passes such a launch. If Yama allows it, for example at
  `ptrace_scope` 0, a same-uid Tool Call can still read that memory through `/proc/<pid>/mem`.
  Start the Coding Agent with `exec`, or pass the key only in the environment of the Coding Agent.
- For the same reason, Bun loads a `.env` file into `process.env`, but that does not change
  `/proc/<pid>/environ`.
- It does not protect a Coding Agent that runs as root with `CAP_SETUID` and `CAP_SETGID`, as in
  `sudo -E coding-agent run ...` or as root in a default Docker container. The shell behind `sudo`
  belongs to another user, so the check is denied its environment and passes over it. A Tool Call
  can take the uid and gid of that user and then read the environment. ADR 0001 §8 leaves this case
  out of scope. Run the Coding Agent as the user that holds the credential, or drop the two
  capabilities, for example with `docker run --cap-drop=SETUID --cap-drop=SETGID`.

`tests/ancestor-credentials.test.ts` checks every outcome with a fake `/proc` on every platform. It
also preloads `tests/support/fail-ancestor-check.ts` into the executable, which makes the check
fail, and checks that the run exits 70 and writes nothing. On Linux it also starts the executable
from two `/bin/sh` launchers that hold a credential. The first launcher runs `exec`, and the run
continues to the configuration. The second launcher stays as the parent, and the run exits 2. That
part is skipped on other platforms, so it runs in CI on Ubuntu.

The test runner is itself an ancestor of each run. If the shell that started `bun test` exported a
provider key, the check rightly refuses every run. `runnerChainIsClean` in
`tests/support/ancestor-chain.ts` finds this case, and the tests that need a run to get past the
check are then skipped. In CI, a test asserts that the runner's chain is clean, so a check that
wrongly refuses the runner fails instead of skipping.
