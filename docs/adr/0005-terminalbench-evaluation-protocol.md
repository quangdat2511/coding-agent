# TerminalBench Evaluation Protocol

Status: proposed

Date: 2026-09-13

## Context

[Define the TerminalBench evaluation protocol](https://datn-fit-hcmus.atlassian.net/browse/CDA-24)
asks which adapter, execution procedure, configuration, artifact capture, reproducibility rules, and
completion criteria make TerminalBench evaluation a required MVP capability, without making a
comparison against Pi a pass or fail gate.

The [Terminal-Bench integration research](../research/terminalbench-integration.md) for
[Determine TerminalBench integration requirements](https://datn-fit-hcmus.atlassian.net/browse/CDA-21)
recommends a Harbor installed agent that runs a headless Coding Agent executable inside each task
container and records Harbor's own rewards. Earlier decisions constrain the protocol:

- The [tool-contract and safety decision](./0001-tool-contracts-and-safety-policy.md) reserves the
  `"auto-approve"` Approval Policy for isolated execution harnesses (§4) and caps `bash` at
  120,000 ms (§3).
- The [MVP context, planning, verification, and session memory decision](./0003-mvp-context-planning-verification-and-session-memory.md)
  makes Verification a non-gating `succeeded` when no verification command is configured (§3) and
  sets the MVP `SessionLimits` defaults (§4).
- The [package API decision](./0004-package-apis-and-dependency-direction.md) makes the command
  line, exit codes, and files written the external contract of `@coding-agent/coding-agent`, and
  leaves this decision to pin the invocation and to place the ATIF trajectory writer and any
  persisted Session Events (§6). The
  [Agent Session state-machine decision](./0002-agent-session-state-machine-and-event-protocol.md)
  requires a schema version once Session Events become persistent data (§7).

This decision was checked against the Harbor and Terminal-Bench source at the commits pinned in §1.
These facts shape it:

- Terminal-Bench 4.0.0, released on 2026-08-26, ten days after the research, removes 8 of
  3.0.0's 74 tasks and revises every remaining task. Harbor 0.22.0 and 0.23.0 followed; 0.23.0
  moves agents from `SUPPORTS_*` flags, now deprecated aliases, to a `capabilities` declaration.
- All 66 tasks in 4.0.0 give the agent 28,800 s, use a separate verifier environment, and have a
  single step. Three request one H100 GPU and eleven are multi-container Docker Compose
  environments. None sets a network mode, so Harbor's default `public` applies.
  `medical-claims-processing` declares an MCP server and `cumulative-layout-shift` a skills
  directory.
- Every base image is a glibc Linux distribution (Debian, Ubuntu, or Fedora); none is Alpine. The
  final `WORKDIR` is `/app` for 58 tasks, `/workspace` for 5, and `/app/sglang`, `/app/vllm`, or
  `/task` for one task each. Six tasks declare the whole `/app` directory as a verifier artifact.
- Harbor passes the task's agent timeout only to its built-in oracle agent. A custom agent cannot
  read it; Harbor enforces it by cancelling the agent's `run()`.
- In a single-step trial, Harbor records `AgentTimeoutError` or `NonZeroAgentExitCodeError` as the
  trial's exception and still runs the verifier. Any other exception raised from `run()` skips
  verification.
- `exec_as_agent` raises a `NonZeroAgentExitCodeError` subclass for every non-zero exit, chosen by
  matching the command's output against provider-error patterns.
- Harbor calls `populate_context_post_run` only when `run()` left the `AgentContext` empty.
- Harbor's `mean` metric counts a trial without a reward as 0.
- In `harbor run`, `-n` is `--n-concurrent` and `-k` is `--n-attempts`. A `--ae` value may be a
  `${VAR}` template resolved from the host environment, and Harbor scrubs the values of
  credential-like keys, such as names containing `KEY`, from the trial directory.

The research needs two corrections. It cites the README at `2b0442c` as running
`terminal-bench/terminal-bench@latest` with `-k 5`, but that commit's README is branded
Frontier-Bench and runs `frontier-bench/frontier-bench` with `-n 5`; the quoted form appears in
the 4.0.0 README. Its version pins are superseded by §1.

## Decision

### 1. Pins

| Component | Pin |
| --- | --- |
| Dataset | `terminal-bench/terminal-bench@4.0.0`, release commit `452bf30`, 66 tasks |
| Harness | `harbor[modal]==0.23.0`, commit `1e5c5c6`, Python 3.12 or newer, resolved through a committed `uv.lock` |
| Recorded-job backend | Modal |
| Coding Agent | one immutable artifact per recorded job (§2), identified by source commit and SHA-256 |

These pins replace CDA-21's Terminal-Bench 3.0.0 and Harbor 0.21.0 baseline. Version 4.0.0 is the
dataset its maintainers currently publish, so a 3.0.0 result would describe a superseded
benchmark. Harbor is pinned exactly rather than by range because its agent API changed between
0.21.0 and 0.23.0. The trial behaviors listed in the context are identical in both versions.

Modal records the run because the benchmark's maintainers develop and validate tasks on it and it
can schedule the three GPU tasks, which Harbor's Docker environment cannot. Docker is permitted
only for the smoke job (§7).

Changing a pin is a new decision that amends this record. Results are never pooled across pins.

### 2. Coding Agent artifact

A recorded job evaluates a standalone executable, not a source checkout. It is built from a commit
on `main` with a clean working tree, for two targets:

```sh
bun build <coding-agent bin entry> --compile --target=bun-linux-x64-baseline \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile coding-agent-linux-x64
bun build <coding-agent bin entry> --compile --target=bun-linux-arm64 \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile coding-agent-linux-arm64
```

- x86-64 covers cloud backends, and arm64 covers Docker smoke jobs on Apple Silicon hosts. The
  adapter selects the executable from the container's architecture (§6). The x86-64 build uses
  Bun's `baseline` target, so it does not require AVX2 on whichever CPU the backend assigns.
- Each executable needs glibc 2.17 or newer and no other runtime. Bun 1.3.14, the version in
  `.bun-version`, cross-compiles both targets from macOS. Installing Bun or Node in each task
  container is rejected: it needs a package manager and network during setup and makes
  installation depend on the task image.
- Autoloading `.env` and `bunfig.toml` is disabled, so files in a task's working directory cannot
  configure the agent.
- The build writes `artifact-manifest.json` with the source commit, the Coding Agent version, the
  Bun version, and each executable's target and SHA-256. `coding-agent --version` prints the same
  version and commit.

### 3. Headless command line

This section pins the invocation that ADR 0004 §6 leaves to this decision. `coding-agent run` is
the headless entry point implemented by `runHeadless`:

```text
coding-agent run
  --task-file <path>              required  UTF-8 file whose entire content is the Coding Task objective
  --provider <provider>           required  anthropic | openrouter | openai | google | xai
  --model <model-id>              required  model identifier within that provider
  --approval-policy auto-approve  required  omission or any other value is a usage error
  --output-dir <dir>              required  created when missing
  --profile <name>                optional  default | terminalbench; defaults to default
  --repo-root <dir>               optional  defaults to the process working directory
```

`--approval-policy auto-approve` is required rather than implied. ADR 0004 §6 selects
`"auto-approve"` only on the headless path and ADR 0001 §4 reserves it for isolated harnesses, so a
person who runs `coding-agent run` outside a harness must opt in on the command line, where the
choice is also visible in the recorded invocation.

The task is read from a file because Harbor instructions are long Markdown documents, and a file
avoids shell quoting and argument-length limits. There are no per-limit flags. An Evaluation
Profile names a source-controlled set of limits (§5), so a build fixes its limits and they cannot
drift between invocations.

Coding Agent reads provider credentials once at startup and removes the provider credential
variables from the environment of `bash` Tool Calls and Verification Runner processes. A
model-issued `env` therefore cannot copy a credential into the transcript, which §8 publishes.

| Exit code | Meaning | Files in `--output-dir` |
| --- | --- | --- |
| 0 | Agent Result `succeeded` | `run.json`, `events.jsonl`, `result.json` |
| 1 | Agent Result `failed` | `run.json`, `events.jsonl`, `result.json` |
| 130 | Agent Result `cancelled` | `run.json`, `events.jsonl`, `result.json` |
| 2 | invalid invocation or configuration; no Agent Session was opened | possibly none |
| 70 | internal Coding Agent error outside the Agent Session | possibly incomplete |

Coding Agent maps `SIGINT` and `SIGTERM` to the `cancel` command (ADR 0004 §3), so a signalled run
settles as `cancelled`, or as `failed` with `CANCELLATION_TIMEOUT`. Standard output and standard
error are diagnostic only and are not part of the contract.

### 4. Files written

Each of the three files carries `"schemaVersion": 1`. Writing Session Events to disk is the point
at which ADR 0002 §7 requires a schema version.

- **`run.json`** is written before `start` is dispatched. It records the Coding Agent version and
  commit, provider and model, the sampling settings bound into the `ModelPort`, the transport
  retry bound (ADR 0004 §2), the resolved `repoRoot`, the profile name and its resolved
  `SessionLimits`, the Approval Policy, the Verification configuration, the registered tool names,
  and the assembled system prompt. It never contains a credential value.
- **`events.jsonl`** holds one Session Event per line, in ADR 0002's envelope, appended as the
  writer receives them. `assistant_content_delta`, `tool_execution_progress`, and
  `verification_progress` are omitted: the completion events carry the final message, Tool Result,
  and evidence, and deltas would dominate the file. Written events keep their `sequence`, so
  omissions appear as gaps. The writer is an ordinary consumer that the producer never awaits
  (ADR 0002 §7), so a killed process can lose the unwritten tail. A reader treats a log that does
  not end with `session_settled` as truncated.
- **`result.json`** is written after `session_settled`. It records the exit code, the Agent Result,
  and the finish time.

When a run fails with `MODEL_FAILURE` after the provider returned an HTTP error, the Agent Result's
failure details include that HTTP status. ADR 0002 §4 already preserves provider failure details;
§7 needs the status to tell provider throttling from agent behavior.

### 5. Evaluation Profile and task conditions

`--profile terminalbench` changes only `SessionLimits`. The system prompt, Project Instructions
discovery, the Scratchpad convention, the tools, and the model settings are the same as under
`default`, so the evaluated agent is the MVP with a larger budget.

| Limit | `default` (ADR 0003 §4) | `terminalbench` |
| --- | --- | --- |
| `maxModelTurns` | 30 | 250 |
| `maxToolCalls` | 100 | 1,000 |
| `maxDurationMs` | 600,000 | 3,600,000 |
| `maxConsecutiveRecoverableFailures` | 3 | 10 |
| `cancellationGraceMs` | Coding Agent default | same as `default` |

Under the defaults most tasks would end with `LIMIT_EXCEEDED` before meaningful work: each task
allows 28,800 s, and an ordinary `grep` that finds nothing returns a `NON_ZERO_EXIT` error Tool
Result, which advances the consecutive-failure counter. A 3,600,000 ms session ends well inside
Harbor's timeout, so the CLI settles and writes `result.json` itself instead of being cancelled
from outside; Harbor's timeout is left unchanged. The turn and Tool Call limits bound model cost per
trial. Both profiles are Coding Agent configuration, which ADR 0003 §4 makes the owner of concrete
limit values, and `default` remains the MVP default.

Inside a task container:

- `repoRoot` is the task's working directory. The adapter sets neither an exec `cwd` nor
  `--repo-root`, so the process starts where the task image places it. ADR 0001 §2's path jail is
  unchanged, and the model reaches paths outside it, such as the `/data` or `/root` paths some
  instructions name, through `bash`. Setting `repoRoot` to `/` was rejected: it disables the jail,
  and the symbolic-link rule would still reject paths such as `/bin` on merged-usr distributions.
- No verification command is configured. Harbor builds the separate verifier environment from the
  task's tests after the agent phase, and the task guidelines forbid copying tests into the agent
  image, so the Verification Policy returns ADR 0003 §3's non-gating `succeeded` with
  `no_command_configured` evidence. The Harbor reward is the only success measure; the Agent Result
  is diagnostic.
- The Coding Task objective is Harbor's instruction, verbatim. No prompt template, extra
  instruction, skill, or MCP configuration is passed, and task-declared MCP servers and skills
  directories are ignored, because MCP and skill loading are outside the MVP. The two affected
  tasks stay in the dataset.

### 6. Harbor adapter

The adapter is a Python project at `evaluation/terminalbench/`, outside the Bun workspaces, with
`harbor[modal]==0.23.0` as its only direct dependency and its own tests. It depends on Coding Agent
only through §3 and §4, so ADR 0004's package graph is unchanged. Its agent class subclasses
`BaseInstalledAgent`, is passed to Harbor as an import path, returns `coding-agent` from `name()`,
and declares `AgentCapabilities(atif=True)`.

`install(environment)`:

1. Reads `uname -m` in the container and selects the matching executable from the `artifact_dir`
   agent kwarg. Any other architecture fails setup.
2. Checks the executable's SHA-256 against `artifact-manifest.json` on the host, uploads it to
   `/installed-agent/coding-agent`, and makes it executable by the agent user.
3. Ensures `bash` exists through Harbor's `ensure_system_dependencies`, because ADR 0001's `bash`
   tool needs it. Nothing else is installed.
4. Runs `coding-agent --version` and fails setup unless the output matches the manifest. `version()`
   returns that version and commit, so Harbor's trial result records which build ran.

`run(instruction, environment, context)`:

1. Uploads the instruction to `/installed-agent/instruction.md`.
2. Executes the following command with no exec `cwd` and no exec timeout:

   ```sh
   /installed-agent/coding-agent run --task-file /installed-agent/instruction.md \
     --provider <provider> --model <model-id> --approval-policy auto-approve \
     --profile terminalbench --output-dir <environment_logs_dir>/coding-agent
   ```

   `<provider>` and `<model-id>` come from Harbor's `-m` value split at its first `/`, so an
   OpenRouter model identifier keeps its own slash. `<environment_logs_dir>` is `/logs/agent` in a
   single-agent trial. The only credential in the process environment is the selected provider's
   key, supplied through `--ae` (§7).
3. Calls `environment.exec` directly rather than `exec_as_agent`, then maps the exit code. For 0,
   1, and 130 the Agent Session settled, so `run()` returns normally and a failed or cancelled Agent
   Result is scored like any other outcome, not recorded as a harness exception. For any other code
   `run()` raises the `NonZeroAgentExitCodeError` subclass that `exec_as_agent` would have raised,
   which Harbor records while still running the verifier.

Because `run()` leaves the `AgentContext` empty, Harbor calls `populate_context_post_run`, which
reads the downloaded `coding-agent/` files and:

- sets `n_input_tokens` (cached tokens included, as Harbor defines it), `n_cache_tokens`, and
  `n_output_tokens` from the Agent Result, or from `model_turn_completed` usage when the event log
  is truncated. `cost_usd` stays unset, because the provider contract carries no pricing;
- sets `metadata` to the Agent Result outcome and failure code, any runtime limit reached, the
  Model Turn and Tool Call counts, the profile, and the artifact SHA-256;
- writes `trajectory.json` beside the logs, converted from `events.jsonl` and validated with
  Harbor's `Trajectory` model before it is written.

The ATIF writer lives in the adapter rather than in `@coding-agent/coding-agent` because ATIF is
Harbor's schema and moves with Harbor: its default version changed from ATIF-v1.7 in 0.21.0 to
ATIF-v1.8 in 0.23.0. Placing the writer beside the Harbor pin confines that churn to one Python
module and keeps the TypeScript packages independent of any benchmark. Harbor's own installed
agents convert their native logs to ATIF the same way.

| Source | ATIF representation |
| --- | --- |
| `run.json` system prompt | `system` step |
| `session_started` Coding Task | `user` step |
| `assistant_message_completed` | `agent` step with text, displayable reasoning, and Tool Calls keyed by Agent Core Tool Call IDs; a failed or cancelled message records its outcome in `extra` |
| `tool_call_completed` | observation result on the step that issued the call; a call without a Tool Result records its outcome in `extra` |
| `model_turn_completed` usage | `metrics` of that turn's step |
| `verification_completed` with `continue` | `user` step containing the injected feedback |
| Agent Result | `final_metrics`, with outcome and failure in `extra` |

### 7. Execution procedure

Every job runs from the repository root with `uv run --project evaluation/terminalbench --frozen`.
Credentials are passed as `${VAR}` templates, so their values appear neither in shell history nor
in the job directory.

1. **Build** the artifact at the evaluated commit (§2).
2. **Oracle job**: `harbor run -d terminal-bench/terminal-bench@4.0.0 -a oracle -e modal -k 1`.
   A task whose oracle reward is below 1 is listed in the report as harness-flaky and stays in the
   denominator.
3. **Smoke job**: the recorded-job command below, restricted with `-i` to `bun-sourcemap-leak`,
   `music-harmony`, and `photonic-waveguide-routing`, three CPU-only single-container tasks with
   small resource requests. It may use `-e docker`. It passes when each trial has a reward, the
   three Coding Agent files, a validated `trajectory.json`, and token counts.
4. **Recorded job**:

   ```sh
   uv run --project evaluation/terminalbench --frozen harbor run \
     -d terminal-bench/terminal-bench@4.0.0 \
     -a <adapter import path> -m <provider>/<model-id> \
     --ak artifact_dir=<artifact directory> \
     --ae <PROVIDER_KEY_ENV>='${<PROVIDER_KEY_ENV>}' \
     -e modal -k 1 -n <concurrency> -r 0 \
     -o <jobs directory> --job-name <job name>
   ```

Rules for the recorded job:

- Exactly one provider and model per job, declared in the manifest. This decision does not choose
  the model.
- One attempt per task. Additional attempts for measuring variance are separate jobs, reported
  separately.
- No task filtering, timeout override, or timeout multiplier. Concurrency is free and recorded; it
  changes wall-clock time, not task conditions.
- No retries. `harbor jobs resume` is used only with its default `--filter-error-type
  CancelledError`, which resumes trials the harness never finished; a finished trial is never rerun.

A recorded job is **valid** when all 66 trials wrote `result.json` and at most three trials failed
for reasons outside Coding Agent. Those reasons are a trial exception other than `AgentTimeoutError`
or `NonZeroAgentExitCodeError`, and an Agent Result failed with `MODEL_FAILURE` whose details record
an HTTP 401, 403, or 429 response. An invalid job is archived and listed, and the whole job is
repeated under a new name.

### 8. Records and reporting

For each recorded job, `evaluation/terminalbench/runs/<job name>/` is committed with two files:

- **`manifest.json`**: the §1 pins, including the Harbor and Modal SDK versions from `uv.lock`; the
  Coding Agent commit, version, Bun version, and artifact SHA-256 values; the `terminalbench`
  profile values; provider, model, and sampling settings; every Harbor flag used; the names, never
  the values, of the environment variables passed; job start and end times; the oracle and smoke
  job names; and the archive's SHA-256.
- **`report.md`**: Harbor's `mean` reward over all 66 trials, with a trial that has no reward
  counted as 0, and the reward distribution; a per-task table of reward, Agent Result outcome and
  failure code, Model Turns, Tool Calls, tokens, duration, and trial exception type; a
  cross-tabulation of Agent Result outcome against reward; the harness-flaky tasks; and the tasks
  whose declared MCP servers or skills were ignored.

The complete Harbor job directory, including every trial's `config.json`, `lock.json`,
`result.json`, verifier output, and agent logs, is too large to commit. It is archived and attached
to a GitHub Release of this repository tagged at the evaluated commit. Before upload, the archive is
searched for the credential values used, and any match blocks publication.

The report has no Pi column and no pass or fail threshold. A later Pi run under the same pins, which
Harbor's built-in `pi` agent would allow, is outside this protocol.

### 9. Completion criteria

TerminalBench evaluation is complete as an MVP capability when:

1. `coding-agent run` implements §3 and §4, with a smoke test for exit codes 0, 1, and 2 and the
   files each writes.
2. The artifact build produces both executables and `artifact-manifest.json`, and `--version`
   matches the manifest.
3. The adapter's tests cover command construction, exit-code mapping, forwarding of exactly one
   provider key, and ATIF conversion of a complete and a truncated event log, each validated
   against Harbor's `Trajectory` model.
4. The oracle, smoke, and recorded jobs of §7 have run, the recorded job is valid, its manifest and
   report are committed, and its archive is published.

No reward value is a criterion.

## Consequences

- `coding-agent run`'s flags, exit codes, and three files become a versioned external contract. A
  change to them changes the adapter in the same pull request.
- The repository gains its first Python project. CI needs a job that runs the adapter's tests with
  `uv`; Biome, the import-alias hook, and `bun --filter` do not cover it.
- Each recorded job costs Modal compute for 66 task environments, three with an H100 GPU, plus model
  usage bounded by 250 Model Turns per task. The oracle job adds compute without model usage.
- Evaluation results describe the `terminalbench` Evaluation Profile, not the shipped defaults.
  Reports name the profile and do not present its results as the `default` profile's.
- Known limitations are measured rather than worked around: the 120,000 ms `bash` cap constrains
  long builds; the two tasks with MCP servers or skills run without them; and in the six tasks that
  hand all of `/app` to the verifier, any Scratchpad files reach the verifier. Removing one of these
  amends ADR 0001, ADR 0003, or the MVP scope, not this protocol.
- Retries and resumption are restricted, so an unreliable provider or backend can invalidate a whole
  job; the three-trial allowance is the only tolerance.
- CDA-21's research remains the background source, with the corrections in this record's context,
  and its pins are superseded by §1.
- Implementation order for §9 belongs to
  [Decide implementation order and the MVP completion checklist](https://datn-fit-hcmus.atlassian.net/browse/CDA-22).
