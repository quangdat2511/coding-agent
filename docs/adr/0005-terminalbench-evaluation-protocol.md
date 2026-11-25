# TerminalBench Evaluation Protocol

Status: accepted

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
- The [MVP context, planning, verification, and run memory decision](./0003-mvp-context-planning-verification-and-session-memory.md)
  makes Verification a non-gating `succeeded` when no verification command is configured (§3) and
  sets the MVP `RunLimits` defaults (§4).
- The [package API decision](./0004-package-apis-and-dependency-direction.md) makes the command
  line, exit codes, and files written the external contract of `@coding-agent/coding-agent`, and
  leaves this decision to pin the invocation and to place the ATIF trajectory writer and any
  persisted Run Events (§6). The
  [Agent Run state-machine decision](./0002-agent-session-state-machine-and-event-protocol.md)
  requires a schema version once Run Events become persistent data (§7).

This decision was checked against Harbor at `1e5c5c6` and Terminal-Bench at `452bf30` (4.0.0). The
dataset is a job parameter, not a pin of this protocol
([ADR 0008](./0008-evaluation-dataset-as-a-job-parameter.md)); that record moves the default pin to
4.1.0 at `4070d6c`, and its release adds and removes no task and makes no agent-facing environment
change, so the environment facts below describe the default pin as well. The verifier facts below
are 4.0.0's; ADR 0008 §4 records the default pin's own. These facts shape it:

- Terminal-Bench 4.0.0, released on 2026-08-26, ten days after the research, removes 8 of
  3.0.0's 74 tasks and revises every remaining task. Harbor 0.22.0 and 0.23.0 followed; 0.23.0
  moves agents from `SUPPORTS_*` flags, now deprecated aliases, to a `capabilities` declaration.
- Every task in 4.0.0 gives the agent 28,800 s, uses a separate verifier environment, and has a
  single step. Three request one H100 GPU and eleven are multi-container Docker Compose
  environments. None sets a network mode, so Harbor's default `public` applies.
  `medical-claims-processing` declares an MCP server and `cumulative-layout-shift` a skills
  directory. These are dataset facts, not protocol constants: §1 makes the dataset a job parameter,
  and ADR 0008 records the default pin's own data and the properties a dataset must have.
- Every base image is a glibc Linux distribution (Debian, Ubuntu, or Fedora); none is Alpine. The
  final-stage `WORKDIR` of the task image, or of the main service's image in a Compose task, is
  `/app` for 58 tasks, `/workspace` for 5, and `/app/sglang`, `/app/vllm`, or `/task` for one task
  each. Six tasks declare the whole `/app` directory as a verifier artifact.
- Harbor passes the task's agent timeout only to its built-in oracle agent. A custom agent cannot
  read it; Harbor enforces it by cancelling the agent's `run()`.
- In a single-step trial, Harbor records `AgentTimeoutError` or `NonZeroAgentExitCodeError` as the
  trial's exception and still runs the verifier. Any other exception raised from `run()` skips
  verification.
- `exec_as_agent` raises a `NonZeroAgentExitCodeError` subclass for every non-zero exit, chosen by
  matching the command's output against provider-error patterns.
- Harbor calls `populate_context_post_run` only when `run()` left the `AgentContext` empty.
- Harbor's `mean` metric counts a trial without a reward as 0.
- Harbor's own retry deletes a trial's directory before running it again, and it selects
  exceptions by exact class name.
- The meanings of the `harbor run` flags the procedure uses are listed with their source in §7.

The research needs two corrections. It cites the README at `2b0442c` as running
`terminal-bench/terminal-bench@latest` with `-k 5`, but that commit's README is branded
Frontier-Bench and runs `frontier-bench/frontier-bench` with `-n 5`, and in Harbor `-n` sets
concurrency rather than repetitions. The quoted `-k 5` form appears in the 4.0.0 README. The
research's version pins are superseded by §1.

## Evidence behind this record

This record contains three kinds of statements, and none should be read as another kind.

**Read in source.** The following were read in Harbor at
[`1e5c5c6`](https://github.com/harbor-framework/harbor/tree/1e5c5c6) and Terminal-Bench at
[`452bf30`](https://github.com/harbor-framework/terminal-bench/tree/452bf30); none was observed in
a running job.

| Statement | Source |
| --- | --- |
| A custom agent does not receive the task's agent timeout | [`trial/trial.py` L1069](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/trial.py#L1069) |
| `AgentTimeoutError` and `NonZeroAgentExitCodeError` are recorded and verification still runs | [`trial/single_step.py` L84](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/single_step.py#L84) |
| Any other exception from the trial's run skips verification | [`trial/trial.py` L426](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/trial.py#L426) |
| `exec_as_agent` raises a classified error on a non-zero exit | [`agents/installed/base.py` L962](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/agents/installed/base.py#L962) |
| `populate_context_post_run` runs only for an empty `AgentContext` | [`trial/trial.py` L935](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/trial.py#L935) |
| `mean` counts a missing reward as 0 | [`metrics/base.py` L25](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/metrics/base.py#L25) |
| Retry deletes the trial directory and matches exact exception class names | [`trial/queue.py` L83](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/queue.py#L83), [L222](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/queue.py#L222), [`models/trial/result.py` L32](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/trial/result.py#L32) |
| Harbor scrubs only values passed through `--ae` and verifier settings, only in UTF-8 text files, replacing them with `[REDACTED]` | [`trial/trial.py` L1008](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/trial.py#L1008), [L1053](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/trial.py#L1053), [`utils/env.py` L5](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/utils/env.py#L5) |
| Tasks default to the `public` network mode | [`models/task/config.py` L70](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/task/config.py#L70) |
| On Modal, exec starts in the explicit `cwd`, else the task's `workdir`, else the final-stage Dockerfile `WORKDIR`; in Compose mode Harbor leaves it unset | [`environments/definition.py` L146](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/environments/definition.py#L146), [`environments/modal.py` L1023](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/environments/modal.py#L1023) |
| Modal declares GPU support outside its VM runtime; Harbor's Docker environment declares none | [`environments/modal.py` L987](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/environments/modal.py#L987), [`environments/docker/docker.py` L311](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/environments/docker/docker.py#L311) |
| The default ATIF version is ATIF-v1.8 (ATIF-v1.7 at Harbor 0.21.0) | [`models/trajectories/trajectory.py` L26](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/trajectories/trajectory.py#L26) |
| The separate verifier environment is built from the task's tests | [`trial/trial.py` L912](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/trial.py#L912) |
| The dataset statistics in the context | every `task.toml`, `environment/Dockerfile` (final-stage `WORKDIR`), `environment/docker-compose.yaml`, and `instruction.md` under [`tasks/`](https://github.com/harbor-framework/terminal-bench/tree/452bf30/tasks), parsed by script; ADR 0008 parsed the 4.1.0 task list the same way |

The Linux behavior behind §7's credential isolation precondition was read in Linux v6.16.
`/proc/<pid>/environ` opens in read mode
([`fs/proc/base.c` L1003](https://github.com/torvalds/linux/blob/v6.16/fs/proc/base.c#L1003)) and
serves the region between `env_start` and `env_end`
([L1028](https://github.com/torvalds/linux/blob/v6.16/fs/proc/base.c#L1028)). Access succeeds for a
caller with the same user and group IDs
([`kernel/ptrace.c` L317](https://github.com/torvalds/linux/blob/v6.16/kernel/ptrace.c#L317)) unless
the target is non-dumpable and the caller lacks `CAP_SYS_PTRACE`
([L342](https://github.com/torvalds/linux/blob/v6.16/kernel/ptrace.c#L342)) or a security module
denies it ([L346](https://github.com/torvalds/linux/blob/v6.16/kernel/ptrace.c#L346)). Yama's
`ptrace_scope` restricts only attach-mode access
([`security/yama/yama_lsm.c` L355](https://github.com/torvalds/linux/blob/v6.16/security/yama/yama_lsm.c#L355)),
which `/proc/<pid>/mem` uses
([`fs/proc/base.c` L874](https://github.com/torvalds/linux/blob/v6.16/fs/proc/base.c#L874)) but
`environ` does not. Whether a backend's container runtime serves `/proc` the same way was not
checked when this record was written, which is why §7's isolation test runs on each backend. The
runs of 2026-11-21, described below, checked two backends.

**Tried locally.** Bun 1.3.14 on macOS arm64 compiled a one-line script for both §2 targets with
both autoload flags. `file` reported glibc-linked x86-64 and aarch64 ELF executables of about
94 MB, and the highest `GLIBC_` symbol version found by `strings` was 2.17, a heuristic rather than
a loader test. The Coding Agent CLI does not exist yet, so its size and behavior are untested.

**Tried on 2026-11-21 (CDA-94).** The isolation test ran from an artifact built at commit
`ff26365`, which is not the evaluated commit, so these runs are evidence about the backends and not
a record of any artifact. The dataset was `terminal-bench/terminal-bench@4.1.0`.

| Backend and kernel | Agent user | Task | Result |
| --- | --- | --- | --- |
| Docker Desktop, `6.12.76-linuxkit` | root | `music-harmony` | passed: `proc-environ` and `proc-mem` denied |
| Docker Desktop, `6.12.76-linuxkit` | uid 10001 | `rs-archive-clone` | passed |
| Modal, `4.19.0-gvisor` | root | `music-harmony` | **failed**: `KEY_FOUND` on `proc-environ`, `proc-mem` and `ancestors`; all four controls found the key and the launcher that keeps its shell was refused |
| Modal | non-root | `fp8-rmsnorm-gemm` | did not run: Modal asks for a payment method before it starts an H100 sandbox |

A diagnostic in the same containers measured the capabilities and the dumpable rule. On Modal the
root user holds `CAP_SYS_PTRACE` (`CapEff` `a80c05fb`, bit 19), and on Docker Desktop it does not
(`a80425fb`). On Modal a child that had set `PR_SET_DUMPABLE` to 0 could be read through
`/proc/<pid>/environ` by root, and was denied to the user `nobody` for `environ` and for `mem`. So
gVisor honours the dumpable rule, and root's `CAP_SYS_PTRACE` is the likely reason that the test
failed, which is the exception that the Linux paragraph above names. Not verified: that this is the
only cause of all three paths, and in particular of `ancestors`.

Modal also ignored the `USER` of two Dockerfiles (`rs-archive-clone` and `risk-scorer-replay`): the
agent ran as root. Harbor's Modal environment switches user only for a task that sets `[agent] user`
in `task.toml`, by wrapping the command in `su <user> -s /bin/bash -c`. At the default pin, only
`fp8-rmsnorm-gemm` sets it, so every other task runs a root agent on Modal. That `su` process is a
root-owned ancestor that holds the key, and a non-root agent is denied its environment.

The precondition of §7 therefore does not hold on Modal for a root agent, and the recorded job stays
blocked there until a later decision amends this record and the precondition is shown to hold on
Modal for the artifact being evaluated (see the CDA-121 note below).

**Tried on 2026-11-22 (CDA-121 prototype).** On Modal (`music-harmony`, root, `4.19.0-gvisor`), a
compiled Bun program that held a disposable key and marked itself non-dumpable was read by its root
child through `environ` and `mem`. After it also removed `CAP_SYS_PTRACE` (its bounding set, and its
effective, permitted and inheritable sets), the same child was denied both, for `Bun.spawnSync` and
for `Bun.spawn`. The only ancestor of the child that held the key was the program itself, which
supports that the `ancestors` leak of CDA-94 was the Coding Agent process and not another one. That is
not verified for the real artifact. Docker Desktop with `--cap-add=SYS_PTRACE` reproduced the leak
locally, and there only the bounding-set drop stopped the root child; clearing the other sets was not
enough. ADR 0001 §7 holds the table and what is not executed. The prototype is commit `c5b47c3` of
the branch `prototype/cda-121-drop-ptrace`, pushed to the same remote as this change and not part of
`main`; its logs are under `prototype/cda-121/` on that branch.

**Assumed, not yet executed.** The smoke job in §7 is the first point at which these are checked:

- No Harbor job has run: Harbor was not installed, the Docker daemon was not running, and no Modal
  account was used.
- That the default pin, `terminal-bench/terminal-bench@4.1.0`, resolves from the registry is taken
  from its [release notes](https://github.com/harbor-framework/terminal-bench/releases/tag/v4.1.0).
- Uploading a roughly 94 MB executable within Harbor's default 360 s agent-setup timeout is
  untested.
- In the eleven Compose tasks, the process starting in the main image's `WORKDIR` follows Docker
  Compose semantics; Harbor's Docker-in-Docker code on Modal was not read.
- What happens to the Coding Agent process after Harbor cancels `run()` on timeout was not traced.
  §5 keeps Agent Runs well inside the task timeout so that the protocol does not depend on it.
- The §6 ATIF mapping has not produced a `trajectory.json` that validates.
- A job directory's size is unknown; §8 handles any size.

**Prescribed.** The CLI flags, exit codes, file names and contents, profile values, adapter steps,
and procedure are decisions, not observations. The source facts above are why they are feasible,
and §9 is where they are shown to work.

## Decision

### 1. Pins

| Component | Pin |
| --- | --- |
| Dataset | a job parameter, `name@version` (ADR 0008 §1); the MVP's default pin is `terminal-bench/terminal-bench@4.1.0`, release commit `4070d6c` |
| Harness | `harbor[modal]==0.23.0`, commit `1e5c5c6`, Python 3.12 or newer, resolved through a committed `uv.lock` |
| Recorded-job backend | Modal |
| Coding Agent | one immutable artifact per recorded job (§2), identified by source commit and SHA-256 |

These pins replace CDA-21's Terminal-Bench 3.0.0 and Harbor 0.21.0 baseline. The dataset is not a
pin of this protocol: a job names its dataset, and the table records only the MVP's default. Version
4.1.0 is the dataset its maintainers currently publish, so a 3.0.0 result would describe a
superseded benchmark. The recorded job's manifest records the dataset it actually ran with its
release commit and task count. Harbor is pinned exactly rather than by range because its agent API
changed between 0.21.0 and 0.23.0. The trial behaviors listed in the context are identical in both
versions.

Modal records the run because the benchmark's maintainers develop and validate tasks on it and it
can schedule GPU tasks, which Harbor's Docker environment cannot. Docker is permitted only for the
smoke job (§7).

Changing the Harbor, backend, or Coding Agent pin is a new decision that amends this record;
changing the default dataset pin amends
[ADR 0008](./0008-evaluation-dataset-as-a-job-parameter.md) instead. A job may name another
admissible dataset without amending either record. Results are never pooled across dataset pins.

On 2026-11-12, [CDA-30](https://datn-fit-hcmus.atlassian.net/browse/CDA-30) amended this record in
four places: §3 accepts `opencode` as a sixth provider value, §7 names the choice that
[ADR 0007](./0007-evaluation-provider-and-model.md) makes, §8 adds the `oc_sk_` prefix to the secret
scan, and the note under Dependencies records that CDA-83 carries the status for this adapter.

On 2026-11-17, [CDA-114](https://datn-fit-hcmus.atlassian.net/browse/CDA-114) amended this record:
the dataset became a job parameter and the default pin moved from 4.0.0 to 4.1.0, following
[ADR 0008](./0008-evaluation-dataset-as-a-job-parameter.md). §1's dataset row names a default
rather than one dataset for every job; §5 states the run bound in terms of an admissible
dataset; §7's two commands take `<dataset>`, its isolation precondition names the job dataset's
images, and its validity rule includes ADR 0008 §3's properties; §8 derives `N` from the job's task
list; and the Consequences follow the job's task list. The task count and smoke task names left this
record for ADR 0008's dataset data.

On 2026-11-21, [CDA-94](https://datn-fit-hcmus.atlassian.net/browse/CDA-94) amended this record:
§7 item 3 asks the artifact manifest to record the passing test run, but the build writes
`artifact-manifest.json` before any test runs and `dist/` is not committed, so the run cannot live
there. The passing runs are recorded in the Isolation Record, a file committed at
`evaluation/terminalbench/isolation/<artifact commit>.json`. It holds each passing run with the day
it was added, and it names the [CDA-29](https://datn-fit-hcmus.atlassian.net/browse/CDA-29)
amendment of ADR 0001 that item 1 requires. The record command takes it with `--isolation-record`,
refuses a job whose backends it does not clear, and copies it into `manifest.json` as
`credentialIsolation`. A backend is cleared when the record holds a passing run as root and one as a
non-root agent user, of an executable that the artifact holds, on the job's dataset. The Evidence
section below holds what the first runs showed.

On 2026-11-22, [CDA-95](https://datn-fit-hcmus.atlassian.net/browse/CDA-95) ran the first smoke job
and the team accepted two exceptions. They apply to that job only, and they change no rule of this
record: §7 step 3 still asks for a reward in every trial, and §7 step 4 still follows the isolation
precondition on Modal.

- The job ran on Docker with `opencode/deepseek-v4.1-flash`, on the artifact built from `main` at
  `1fd9966`, which is the artifact of the Isolation Record committed for that commit. The trial of
  `bun-sourcemap-leak` has no reward: the verifier of the task stops with `Worker can access
  private path: /logs/verifier`. An oracle run of the same task on Docker, with no model and no key,
  stops the same way, so the task is harness-flaky on Docker. The team accepted the smoke job with a
  reward on the other two trials. It is not known whether the verifier fails on Modal, where the
  recorded job runs, or why it fails on Docker.
- Two trials (`photonic-waveguide-routing`, `music-harmony`) ended with `MODEL_FAILURE` when one
  Model Turn produced exactly 65,536 output tokens, all of them reasoning, after 466 s and 514 s;
  the provider's usage log shows the finish reason `length`. The artifact sends no output limit and
  no reasoning effort for `opencode` (`SAMPLING_BY_PROVIDER` in `run-config.ts`). The team accepted
  this as a known risk and not as a defect to fix before the recorded job, which may meet it again
  and lose those tasks. [ADR 0007](./0007-evaluation-provider-and-model.md) keeps the job at the
  provider's default effort, so a change of this setting amends that record.

That Isolation Record covers Docker only and is bound to the executable that this smoke job ran. It
is not the record of the recorded job: a changed artifact needs a new record (§9 criterion 4).

On 2026-11-22, [CDA-121](https://datn-fit-hcmus.atlassian.net/browse/CDA-121) amended this record:
ADR 0001, whose §7 now has a CDA-121 amendment, prescribes the answer to the Modal failure of
CDA-94: under `"auto-approve"` Coding Agent removes `CAP_SYS_PTRACE` before its first child and
refuses to run if it remains. The
[Isolation Record for `e48b12a`](../../evaluation/terminalbench/isolation/e48b12ad1758b2016d78c04d76f591cedfdf0098.json)
records the passing runs of that `main` artifact on 2026-11-22 for
`terminal-bench/terminal-bench@4.1.0`: Docker as root and non-root, and Modal as root.
When creating an Isolation Record, the adapter requires an explicit declaration of the ADR
amendments implemented by its artifact. This Record names both CDA-29 and CDA-121. Later runs
preserve the declaration in the existing Record.

The Modal non-root run on `fp8-rmsnorm-gemm` reached UID 1000 and was inconclusive
(`MEM_NOT_DEMONSTRABLE`). Yama `ptrace_scope=1` blocked the `proc-mem` control. Under the
current test, the control must show that the path can recover the disposable credential from the
unhardened process, and the probe against the evaluated artifact must show that the same path
cannot recover it. The Record still lacks a passing Modal non-root run, so the recorded job
remains blocked under §7. ADR 0001 §7 records the results, and
[CDA-96](https://datn-fit-hcmus.atlassian.net/browse/CDA-96) tracks the remaining evidence.

On 2026-11-23, [CDA-96](https://datn-fit-hcmus.atlassian.net/browse/CDA-96) amended this record:
the team accepted a smaller dataset for CDA-96's recorded job instead of the default pin. Running
the default pin's 66 tasks on Modal is too expensive for the project's budget, so CDA-96 records a
job on `factory-ai/legacy-bench@v0.1` (10 tasks) and accepts the trade-off that its result is not
comparable with a TerminalBench result and is never pooled with one. That job is not valid under
§7: the dataset has no separate verifier environment (ADR 0008 §3 property 3), its per-task agent
timeout is below the profile's 3,600,000 ms (property 4), and the rehearsal raised the timeout 13×.
Its record names the three waived requirements — credential isolation, dataset release tag and
timeout override — in `manifest.json` and `report.md`, and publishes no headline reward. The
artifact's Isolation Record names both the CDA-29 and the CDA-121 amendments and holds a passing
root run on Modal for `harbor/hello-world@1` and `factory-ai/legacy-bench@v0.1`; the non-root
requirement is waived in the two CDA-96 rehearsal records, while the shared Isolation Record
keeps the evidence of all three datasets. The non-root run on `fp8-rmsnorm-gemm` was attempted on
2026-11-22 and returned `INCONCLUSIVE` (`MEM_NOT_DEMONSTRABLE`, because Yama `ptrace_scope=1`
blocks the `proc-mem` control), so a passing non-root run is still missing. It needs an H100 and a
Modal payment method, which the project's budget does not cover, and the team agreed not to pursue
that run further: Modal therefore stays uncleared for a non-root agent. CDA-97 scans, archives and
publishes this record. The runs that started before §9 criterion 4 held do not count, and their
credential is subject to revocation under §9; the ticket tracks the owner's confirmation.

On 2026-11-24, [CDA-147](https://datn-fit-hcmus.atlassian.net/browse/CDA-147) amended this record:
the event log of §4 follows ADR 0002's rename of Agent Session to Agent Run. In `events.jsonl` the
envelope's id is `runId`, formerly `sessionId`, and its value starts with `run-`; the first and last
events are `run_started` and `run_settled`, formerly `session_started` and `session_settled`.
Because the envelope changed, all three files now carry `"schemaVersion": 2`, so the adapter
refuses an older file with a version error rather than misreading it. The MVP job's published
archives keep the old names at version 1.

On 2026-11-25, [CDA-166](https://datn-fit-hcmus.atlassian.net/browse/CDA-166) amended this record:

- The headless event log (§4) omits Tool Result details from `tool_call_completed`.
  [Tool Details decision](https://datn-fit-hcmus.atlassian.net/browse/CDA-155?focusedCommentId=10375)
- The headless agent (§5) acquires managed binaries on first use inside the task container.
  [Managed binary acquisition decision](https://datn-fit-hcmus.atlassian.net/browse/CDA-160?focusedCommentId=10373)

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
  --provider <provider>           required  anthropic | openrouter | openai | google | xai | opencode
  --model <model-id>              required  model identifier within that provider
  --approval-policy auto-approve  required  omission or any other value is a usage error
  --output-dir <dir>              required  created when missing
  --profile <name>                optional  default | terminalbench; defaults to default
  --repo-root <dir>               optional  defaults to the process working directory
```

`--approval-policy auto-approve` is required rather than implied. ADR 0004 §6 selects
`"auto-approve"` only on the headless path and ADR 0001 §4 reserves it for isolated harnesses, so a
person who runs `coding-agent run` outside a harness must opt in on the command line, where the
choice is also visible in the recorded invocation. The flag only makes the choice explicit. It does
not detect whether the process really runs in an isolated harness, which remains the caller's
obligation under ADR 0001 §4.

The task is read from a file because Harbor instructions are long Markdown documents, and a file
avoids shell quoting and argument-length limits. There are no per-limit flags. An Evaluation
Profile names a source-controlled set of limits (§5), so a build fixes its limits and they cannot
drift between invocations.

| Exit code | Meaning | Files in `--output-dir` |
| --- | --- | --- |
| 0 | Agent Result `succeeded` | `run.json`, `events.jsonl`, `result.json` |
| 1 | Agent Result `failed` | `run.json`, `events.jsonl`, `result.json` |
| 130 | Agent Result `cancelled` | `run.json`, `events.jsonl`, `result.json` |
| 2 | invalid invocation or configuration; no Agent Run was opened | possibly none |
| 70 | internal Coding Agent error outside the Agent Run | possibly incomplete |

Coding Agent maps `SIGINT` and `SIGTERM` to the `cancel` command (ADR 0004 §3), so a signalled run
settles as `cancelled`, or as `failed` with `CANCELLATION_TIMEOUT`. Standard output and standard
error are diagnostic only and are not part of the contract.

### 4. Files written

Each of the three files carries `"schemaVersion": 2`. Writing Run Events to disk is the point
at which ADR 0002 §7 requires a schema version.

- **`run.json`** is written before `start` is dispatched. It records the Coding Agent version and
  commit, provider and model, the sampling settings bound into the `ModelPort`, the transport
  retry bound (ADR 0004 §2), the resolved `repoRoot`, the profile name and its resolved
  `RunLimits`, the Approval Policy, the Verification configuration, the registered tool names,
  and the assembled system prompt. It never contains a credential value.
- **`events.jsonl`** holds one Run Event per line, in ADR 0002's envelope, appended as the
  writer receives them. `assistant_content_delta`, `tool_execution_progress`, and
  `verification_progress` are omitted because deltas would dominate the file. The completion
  events carry the final message, Tool Result, and evidence. The writer keeps `tool_call_completed`
  and all its other fields while omitting the Tool Result's `details` from the serialized event.
  Written events keep their `sequence`, so omitted events appear as gaps. The writer is an ordinary
  consumer that the producer never awaits (ADR 0002 §7), so a killed process can lose the unwritten
  tail. A reader treats a log that does not end with `run_settled` as truncated.
- **`result.json`** is written after `run_settled`. It records the exit code, the Agent Result,
  and the finish time.

### 5. Evaluation Profile and task conditions

`--profile terminalbench` changes only `RunLimits`. The system prompt, Project Instructions
discovery, the Scratchpad convention, the tools, and the model settings are the same as under
`default`, so the evaluated agent is the MVP with a larger budget.

| Limit | `default` (ADR 0003 §4) | `terminalbench` |
| --- | --- | --- |
| `maxModelTurns` | 30 | 250 |
| `maxToolCalls` | 100 | 1,000 |
| `maxDurationMs` | 600,000 | 3,600,000 |
| `maxConsecutiveRecoverableFailures` | 3 | 10 |
| `cancellationGraceMs` | Coding Agent default | same as `default` |

Under the defaults most tasks would end with `LIMIT_EXCEEDED` before meaningful work: each task in
the default pin allows 28,800 s, and ADR 0008 requires every admissible dataset to give each task
at least the 3,600,000 ms Agent Run. A shell `grep` that finds no matches through `bash` returns a
`NON_ZERO_EXIT` error Tool Result, which advances the consecutive-failure counter. A 3,600,000 ms
Agent Run ends well inside Harbor's timeout, so the CLI settles and writes `result.json` itself
instead of being cancelled from outside; Harbor's timeout is left unchanged. The turn and Tool Call
limits bound model cost per trial. Both profiles are Coding Agent configuration, which ADR 0003 §4
makes the owner of concrete limit values, and `default` remains the MVP default.

Inside a task container:

- `repoRoot` is the task's working directory. The adapter sets neither an exec `cwd` nor
  `--repo-root`, so the process starts where the task image places it. ADR 0001 §2's path jail is
  unchanged, and the model reaches paths outside it, such as the `/data` or `/root` paths some
  instructions name, through `bash`. Setting `repoRoot` to `/` was rejected: it disables the jail,
  and the symbolic-link rule would still reject paths such as `/bin` on merged-usr distributions.
- No verification command is configured, because the agent has no tests to run: Harbor builds the
  separate verifier environment from the task's tests after the agent phase, and the task
  guidelines forbid copying tests into the agent image.
- `openAgentRun` still requires a `VerificationPolicy` (ADR 0004 §3). The headless path passes
  the same Verification Policy implementation as the interactive path (ADR 0004 §7), constructed
  without a command; it is not a separate no-op policy. At each Candidate Completion, Agent Core
  enters `verifying` and emits `verification_started`. The policy returns `succeeded` with
  `{ type: "no_command_configured", workspaceChanged }` evidence (ADR 0003 §3), and Agent Core
  emits `verification_completed` and moves to `succeeded` (ADR 0002 §2). The policy never returns
  `continue`, so Verification adds no Model Turn, and the first Candidate Completion ends the Agent
  Run. A model that stops early ends its trial early. The Harbor reward is the only success
  measure; the Agent Result is diagnostic.
- The Coding Task objective is Harbor's instruction, verbatim. No prompt template, extra
  instruction, skill, or MCP configuration is passed, and task-declared MCP servers and skills
  directories are ignored, because MCP and skill loading are outside the MVP. The two affected
  tasks stay in the dataset.
- The headless agent acquires `rg` on the first `grep` call and `fd` on the first `find` call
  inside the task container. It checks the per-trial cache and then `PATH` for the pinned version.
  When neither has that version and the agent is online, it downloads the pinned asset under the
  task's network mode and installs the binary in the cache. The cache defaults to a directory
  under the agent user's home with a temporary-directory fallback. If the agent is offline or
  the download fails, it can use a binary on `PATH` that meets the minimum version. If acquisition
  fails, the Tool Call returns a recoverable `TOOL_INTERNAL_ERROR` and the model can fall back to
  `bash`. The adapter installation follows §6.

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
2. Executes the following command with no exec `cwd` and no exec timeout. Harbor runs it through a
   shell that holds the provider key, so the command `exec`s the agent, replacing that shell, and
   pipes its output nowhere:

   ```sh
   exec /installed-agent/coding-agent run --task-file /installed-agent/instruction.md \
     --provider <provider> --model <model-id> --approval-policy auto-approve \
     --profile terminalbench --output-dir <environment_logs_dir>/coding-agent
   ```

   `<provider>` and `<model-id>` come from Harbor's `-m` value split at its first `/`, so an
   OpenRouter model identifier keeps its own slash. `<environment_logs_dir>` is `/logs/agent` in a
   single-agent trial. The only credential in the process environment is the selected provider's
   key, supplied through `--ae`. The `exec` and the absence of a pipeline satisfy
   [ADR 0001 §8](./0001-tool-contracts-and-safety-policy.md)'s `"auto-approve"` launch contract:
   Harbor's launcher shell is replaced rather than left alive holding the key, and no `tee`/`grep`
   sibling retains it. Coding Agent's own startup ancestor check (ADR 0001 §8) then confirms no
   ancestor holds the key before it opens the Agent Run, so an adapter that failed to `exec`
   would abort the trial rather than leak. No job may run until that key is unreachable from Tool
   Call processes (§7).
3. Calls `environment.exec` directly rather than `exec_as_agent`, then maps the exit code. For 0,
   1, and 130 the Agent Run settled, so `run()` returns normally and a failed or cancelled Agent
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
| `run_started` Coding Task | `user` step |
| `assistant_message_completed` | `agent` step with text, displayable reasoning, and Tool Calls keyed by Agent Core Tool Call IDs; a failed or cancelled message records its outcome in `extra` |
| `tool_call_completed` | observation result on the step that issued the call; a call without a Tool Result records its outcome in `extra` |
| `model_turn_completed` usage | `metrics` of that turn's step |
| `verification_completed` with `continue` | `user` step containing the injected feedback |
| Agent Result | `final_metrics`, with outcome and failure in `extra` |

The `agent` row names displayable reasoning, but Coding Agent has none to map: an Assistant Message
carries text and Tool Calls only, the providers normalize no reasoning content into it, and §4
omits the `assistant_content_delta` events that would carry it. The step therefore has no
`reasoning_content`, and the reasoning tokens that a provider reports stay in the metrics.

### 7. Execution procedure

Every job runs from the repository root with `uv run --project evaluation/terminalbench --frozen`.
Credentials are passed as `${VAR}` templates, which Harbor resolves from the host environment
([`agents/factory.py` L146](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/agents/factory.py#L146)),
so their values do not appear in shell history. The job's `config.json` holds no full credential
in any case, because Harbor serializes the agent environment through `templatize_sensitive_env`
([`utils/env.py`](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/utils/env.py)).
It keeps a template as written and stores a literal that equals the host variable as `${VAR}`. It
masks any other literal of a sensitive variable, and keeps the first 4 and the last 3 characters
of a value longer than 8 characters. The adapter receives only resolved values, so it cannot refuse
a literal that equals the host variable (see `evaluation/terminalbench/README.md`).

The procedure relies on these Harbor 0.23.0 flag meanings. `-n` in particular is not a repetition
count.

| Flag | Meaning at `1e5c5c6` | Source |
| --- | --- | --- |
| `-k`, `--n-attempts` | independent attempts per task; default 1 | [`cli/jobs.py` L458](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L458), [`models/job/config.py` L403](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/job/config.py#L403) |
| `-n`, `--n-concurrent` | number of trials running at the same time; affects wall-clock time only | [`cli/jobs.py` L539](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L539) |
| `-r`, `--max-retries` | reruns of a trial that ended with an exception; default 0. An exception qualifies by exact class name, and the trial directory is deleted before each rerun | [`cli/jobs.py` L564](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L564), [`trial/queue.py` L83](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/queue.py#L83), [L222](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/queue.py#L222) |
| `-i`, `--include-task-name` | runs only the named tasks; glob patterns allowed | [`cli/jobs.py` L1152](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L1152) |
| `--ae`, `--agent-env` | `KEY=VALUE` environment variable for the agent | [`cli/jobs.py` L670](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L670) |
| `harbor jobs resume -f`, `--filter-error-type` | before resuming, deletes trials without `result.json` and trials whose exception type is listed; default `CancelledError` | [`cli/jobs.py` L2190](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L2190), [`job.py` L268](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/job.py#L268) |

**Credential isolation precondition.** The smoke, recorded, and rerun jobs place a provider
credential in a task container where `bash` runs auto-approved and the network is public. Any
process that can read that credential can send it anywhere during the trial. §8's secret scan
inspects only the archive afterwards, so it can neither detect nor prevent that. None of these
jobs may start until all of the following hold:

1. [CDA-29](https://datn-fit-hcmus.atlassian.net/browse/CDA-29) is resolved by an accepted
   amendment to ADR 0001.
2. The resolution guarantees that no process started by a Tool Call or the Verification Runner can
   obtain the provider credential: not from its inherited environment, not from
   `/proc/<pid>/environ` of the Coding Agent process, and not from that process's memory. Removing
   the variable from child environments does not meet this by itself. Linux lets a process with the
   same user and group read another process's `/proc/<pid>/environ` unless the target is
   non-dumpable or a security module denies it, and serves that file from the process's original
   environment region (see Evidence).
3. The artifact under evaluation implements the resolution, and an automated test demonstrates it
   on every backend the job will use. The test runs inside containers built from the task images of
   the dataset the job will use, as the user Harbor runs the agent as: at least one task whose agent
   runs as root and one whose agent runs as a non-root user. Tool Calls in the test attempt each
   path in item 2, and none reveals the credential. The artifact manifest records the ADR amendment
   and the passing test run for the artifact's commit and backend.

If CDA-29 resolves that tool processes may obtain the credential, these jobs remain blocked until a
new decision amends this record, for example by keeping the credential out of the task container.
The oracle job receives no credential and is not gated.

1. **Build** the artifact at the evaluated commit (§2).
2. **Oracle job**: `harbor run -d <dataset> -a oracle -e modal -k 1`.
   A task whose oracle reward is below 1 is listed in the report as harness-flaky and stays in the
   denominator.
3. **Smoke job**, only after the credential isolation precondition holds for its backend: the
   recorded-job command below, restricted with `-i` to the smoke tasks recorded for that dataset
   before the smoke job starts: ADR 0008 §4 for the default pin, and the committed dataset record of
   ADR 0008 §1 for any other dataset. The smoke set is three CPU-only single-container tasks with
   small resource requests, and which three is dataset data. It may use `-e docker`. It passes when
   each trial has a reward, the three Coding Agent files, a validated `trajectory.json`, and token
   counts.
4. **Recorded job**, only after the credential isolation precondition holds on Modal for the
   artifact being evaluated:

   ```sh
   uv run --project evaluation/terminalbench --frozen harbor run \
     -d <dataset> \
     -a <adapter import path> -m <provider>/<model-id> \
     --ak artifact_dir=<artifact directory> \
     --ae <PROVIDER_KEY_ENV>='${<PROVIDER_KEY_ENV>}' \
     -e modal -k 1 -n <concurrency> -r 0 \
     -o <jobs directory> --job-name <job name>
   ```

5. **Rerun job**, only when the rule below selects trials: the recorded-job command, under the same
   precondition, with the same `<dataset>`, one `-i` per selected task and
   `--job-name <job name>-rerun`.

`<dataset>` is a `name@version` registry dataset, not a local path and not `latest` (ADR 0008 §1).
The MVP's recorded job uses the default pin; a job that names another admissible dataset is a
separate experiment and records it in its manifest. The manifest records the dataset fields §8
lists. No rule here depends on the default pin's task count or smoke names.

Rules for the recorded job:

- Exactly one provider and model per job, declared in the manifest. This decision does not choose
  the model; [ADR 0007](./0007-evaluation-provider-and-model.md) chooses `opencode` with
  `deepseek-v4.1-flash` and bounds what that job may claim.
- Exactly one dataset pin per job, declared in the manifest with its release commit and task count.
  Results are comparable only within that pin and are never pooled across pins (ADR 0008 §1). A
  recorded-job and its rerun job use the same pin.
- One attempt per task (`-k 1`). Additional attempts for measuring variance are separate jobs,
  reported separately.
- No task filtering outside the rerun job, and no timeout override or timeout multiplier.
  Concurrency is free and recorded, because it changes wall-clock time, not task conditions.
- `-r 0`. Harbor's own retry is not used, because it deletes the failed trial's directory, which is
  the evidence the report must describe. A failed trial is rerun in the separate rerun job instead.
- `harbor jobs resume` is used only with its default `--filter-error-type CancelledError`, so it
  removes only trials that the harness never finished or cancelled.

A trial is **rerun-eligible** when either condition holds:

- Its `result.json` has no verifier reward. Harbor still verifies after `AgentTimeoutError` and
  `NonZeroAgentExitCodeError`, the only errors that the adapter's `run()` raises (§6). The
  adapter's `install()` raises `ArtifactInstallError`, which fails setup before the Agent Run
  starts. So a missing reward means the trial failed outside the Agent Run: while building or
  starting the environment, installing or launching the agent, or running the verifier.
- Its Agent Result failed with `MODEL_FAILURE` and the failure details record an HTTP 401, 403, 429,
  or 5xx response from the provider. This condition depends on a decision outside this record; see
  Dependencies.

Every rerun-eligible trial runs exactly once more, in one rerun job with the same artifact and
flags. A rerun trial is never rerun. A trial is **completed** when it has a verifier reward and is
not rerun-eligible. Each task's recorded outcome is its original trial when that trial completed,
and its rerun trial otherwise.

The recorded job is **valid** when every task has a completed trial in the recorded job or the
rerun job, and the job's dataset has the properties
[ADR 0008](./0008-evaluation-dataset-as-a-job-parameter.md) §3 requires. A job that is not valid
publishes no headline reward, but both jobs are still archived and reported.

### 8. Records and reporting

For each recorded job, `evaluation/terminalbench/runs/<job name>/` is committed with two files:

- **`manifest.json`**: the §1 pins, including the Harbor and Modal SDK versions from `uv.lock`; the
  job's dataset identifier, source repository and release tag, resolved release commit, task count,
  resolved task list, and smoke set, with the evidence that the dataset has the properties
  [ADR 0008](./0008-evaluation-dataset-as-a-job-parameter.md) §3 requires; the
  Coding Agent commit, version, Bun version, and artifact SHA-256 values; the `terminalbench`
  profile values; provider, model, and sampling settings; every Harbor flag used; the names, never
  the values, of the environment variables passed; job start and end times; the oracle, smoke, and
  rerun job names; the secret scan's patterns, file count, and result; and the SHA-256 of every
  archive part.
- **`report.md`**: whether the job is valid (§7); the dataset identifier and release commit the
  report describes, and that its result is comparable only with jobs on that pin and is never
  pooled with another; the mean reward over the job's `N` recorded outcomes, where `N` is the
  number of tasks in the job's resolved task list rather than a constant, computed as Harbor's
  `mean` computes it, and the reward distribution; a per-task table of reward, Agent Result outcome
  and failure code, Model Turns, Tool Calls, tokens, duration, and trial exception type; a
  cross-tabulation of Agent Result outcome against reward; every rerun-eligible trial with its
  reason, meaning the exception type and the phase it occurred in (from the trial's
  `environment_setup`, `agent_setup`, `agent_execution`, and `verifier` timings) or the provider's
  HTTP status, together with its rerun's outcome; the harness-flaky tasks; and the tasks whose
  declared MCP servers or skills were ignored.

The complete Harbor job directories of the recorded and rerun jobs, including every trial's
`config.json`, `lock.json`, `result.json`, verifier output, and agent logs, are too large to commit.
They are archived and attached to a GitHub Release of this repository tagged at the evaluated
commit. The repository is private, so release assets are visible to everyone with read access to
it; publication is still treated as permanent. GitHub requires each release asset to be under
2 GiB and allows up to 1,000 assets per release, with no limit on total size
([GitHub documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)),
so an archive of 2 GiB or more is split into parts.

On 2026-11-23, [CDA-97](https://datn-fit-hcmus.atlassian.net/browse/CDA-97) published the archives
of the two CDA-96 rehearsal records. The GitHub Release
[`terminalbench-e48b12a`](https://github.com/quangdat2511/coding-agent/releases/tag/terminalbench-e48b12a)
is tagged at the evaluated commit `e48b12ad…`, not at the commit that holds the records, and it
holds one asset per record: a single zstd tar part under the 2 GiB asset limit, whose SHA-256 is the
value the record's `manifest.json` holds. The scan of this section ran over both uncompressed job
directories before the upload: 130 files, no credential value, no `[REDACTED]` occurrence and no
key-prefix match, so step 4 of this section had no object and the scanner reported a pass. The
`oc_sk_` prefix of step 3 matches the key the jobs used, but that comparison was made after the
upload and after the key was rotated, so the precondition that step 3 makes before publication was
not met. CDA-97 records AC1 as not met for that reason, while both manifests keep
`secretScan.result: "passed"` as the scanner's own result. §9 criterion 5 separately revokes the
credential of every smoke, recorded and rerun job that started before criterion 4 held; criterion 4
never held for a non-root agent on Modal, so its owner rotated `OPENCODE_API_KEY` on 2026-11-23,
revoking the old value, and CDA-97 records the confirmation. §9 criterion 5 remains unmet: each
record is invalid under §7 for the reasons its report states — the ADR 0008 §3 dataset properties
that its dataset fails, and the waivers CDA-96 records (credential isolation, and for legacy-bench
the dataset release tag and the timeout override) — and §9 criterion 4 still lacks a passing
non-root run on Modal. The repository was public when the release was published, contrary to this
section's assumption that it is private, so the archives are visible to anyone.

Agent logs can contain credentials, because a Tool Result records command output. Harbor's scrub
does not make them safe. At the end of each trial it replaces values passed through `--ae` or
verifier settings with `[REDACTED]`, but only in files that look like UTF-8 text
([`trial/trial.py` L1044](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/trial.py#L1044),
[L1053](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/trial/trial.py#L1053)).
The replacement also erases the evidence that a key leaked. Publication therefore requires a
secret scan. The scan protects only the archive: it cannot detect or prevent a credential sent over
the network while a trial ran, which only §7's credential isolation precondition addresses. Every
step below is mandatory, and a failed step blocks the upload:

1. Search every file in the uncompressed job directories, including binary files and files Harbor
   did not scrub, for the exact value of every credential the jobs used. A match fails the scan.
2. Search the same files for `[REDACTED]`. Each occurrence is reviewed. One that Harbor wrote over a
   credential means the credential appeared in the logs, even though its value is gone.
3. Search the same files for the provider key prefixes `sk-ant-`, `sk-or-`, `sk-proj-`, `xai-`,
   `AIza`, and `oc_sk_` ([OpenCode's harness page](https://opencode.ai/docs/console/harnesses) shows
   the prefix in its key example, read 2026-11-12; confirm it against a live key before relying on
   this step, because a different prefix would leave a truncated key unmatched). Each match is
   reviewed, and the scan fails until every match is shown not to be a credential or is removed from
   the archive.
4. Revoke every credential that steps 1 to 3 show appeared in the logs, whether or not it would
   have been published, because the logs may already have been sent to the model provider and are
   already on the host.
5. Record the scan's patterns, file count, and result in the manifest.

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
4. **Prerequisite for criterion 5:** §7's credential isolation precondition holds. CDA-29 is
   resolved by an accepted ADR 0001 amendment, the evaluated artifact implements it, and the
   isolation test has passed on each backend used, for that artifact's commit.
5. The oracle, smoke, recorded, and any rerun jobs of §7 have run; every smoke, recorded, and rerun
   job started after criterion 4 held for its artifact and backend; the recorded job is valid under
   §7; its manifest and report are committed; and its archive passed §8's secret scan and is
   published. A smoke, recorded, or rerun job that started before criterion 4 held does not count,
   and its credential is revoked.

No reward value is a criterion.

## Dependencies

This protocol relies on two behaviors that belong to other decisions. It states what it needs from
them and decides neither.

- **Credential isolation for tool processes:**
  [CDA-29](https://datn-fit-hcmus.atlassian.net/browse/CDA-29), resolved by
  [ADR 0001 §8](./0001-tool-contracts-and-safety-policy.md). This is tool safety policy owned by
  ADR 0001, and the exposure is the same on the interactive path. It is a blocking prerequisite,
  not an open question the procedure can run around: §7 forbids the smoke, recorded, and rerun jobs
  until ADR 0001 §8 is accepted, implemented in the evaluated artifact, and confirmed by the
  per-backend test, and §9 makes that criterion 4. Without it, a model-issued command can read the
  key and send it over the task's public network during a trial, which no later check can undo.
- **The provider's HTTP status in `MODEL_FAILURE` details.** §7's second rerun condition reads it.
  ADR 0002 §4 preserves a normalized provider reason in the failure details, but no decision says
  the HTTP status is part of that reason. Until the provider error contract includes it, a
  `MODEL_FAILURE` without a recorded status is not rerun-eligible and counts as an agent outcome.
  [ADR 0007](./0007-evaluation-provider-and-model.md) names `opencode`, so
  [CDA-83](https://datn-fit-hcmus.atlassian.net/browse/CDA-83) implements the status in that
  adapter.

  On 2026-11-17, CDA-83 amended this note. The status is `httpStatus` in the declared
  `ModelFailureDetails` of a `MODEL_FAILURE`, beside `phase`, `reason` and `rawReason`, and
  `result.json` holds it, so the second condition of §7 now has the value it reads. These limits
  decide which failures can meet that condition:
  - Only the Chat Completions adapter records it, which covers `openai`, `openrouter`, `xai` and
    `opencode`. The `anthropic` and `google` adapters do not, so a failure on either never meets
    the condition.
  - It is the status of a response that failed the request. After the SDK's transport retries it
    is the last attempt's.
  - An error that the provider sends after it answered HTTP 200 has no status, because the SDK
    raises it without one, so it never meets the condition, however the provider words it. Only a
    request that the provider refused before the stream opened can.
  - The adapter records any status and §7 chooses among them. Go answered a request for a model it
    does not serve with HTTP 400, which §7 does not list. The status Go returns once an allowance
    window is exhausted has not been observed, and the smoke job records it (ADR 0007 §2).

## Consequences

- `coding-agent run`'s flags, exit codes, and three files become a versioned external contract. A
  change to them changes the adapter in the same pull request.
- The repository gains its first Python project. CI needs a job that runs the adapter's tests with
  `uv`; Biome, the import-boundary hook, and `bun --filter` do not cover it.
- Each recorded job costs Modal compute for one task environment per task in the job's dataset, and
  an H100 for each GPU task the dataset declares, plus model usage bounded by 250 Model Turns per
  task. The oracle job adds compute without model usage. A job on another admissible dataset costs
  in proportion to its task list and GPU tasks.
- Evaluation results describe the `terminalbench` Evaluation Profile, not the shipped defaults.
  Reports name the profile and do not present its results as the `default` profile's.
- A result is comparable only within one dataset pin. The dataset is a job parameter
  ([ADR 0008](./0008-evaluation-dataset-as-a-job-parameter.md)), so a job on another admissible
  dataset is recorded and reported on its own and never pooled with another pin's result.
- Known limitations are measured rather than worked around: the 120,000 ms `bash` cap constrains
  long builds; the two tasks with MCP servers or skills run without them; and in the tasks that hand
  all of `/app` to the verifier (ADR 0008 §4 lists the default pin's), any Scratchpad files reach the
  verifier. Removing one of these amends ADR 0001, ADR 0003, or the MVP scope, not this protocol.
- A trial that fails outside Coding Agent is rerun once in a separate job. That costs a second task
  environment, but it keeps the failed trial's evidence. A persistent backend or provider fault
  leaves the job without a headline result instead of shrinking the denominator.
- No job that receives a provider credential can run until CDA-29 is resolved, implemented, and
  tested on the backend, so the evaluation cannot start before that ADR 0001 amendment. The
  mandatory secret scan protects published archives only and is not a substitute.
- CDA-21's research remains the background source, with the corrections in this record's context,
  and its pins are superseded by §1.
- Implementation order for §9 belongs to
  [Decide implementation order and the MVP completion checklist](https://datn-fit-hcmus.atlassian.net/browse/CDA-22).
