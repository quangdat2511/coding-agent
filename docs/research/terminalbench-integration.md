# CDA-21 — Terminal-Bench integration requirements

> **Corrections (2026-09-13).** The
> [TerminalBench evaluation protocol](../adr/0005-terminalbench-evaluation-protocol.md) (ADR 0005)
> supersedes two points in this report. Read it before implementing from this report.
>
> - **Pins.** Evaluation is re-pinned to Terminal-Bench 4.0.0 and Harbor 0.23.0. The Terminal-Bench
>   3.0.0 and Harbor 0.21.0 pins below are no longer the baseline.
> - **README citation and the `-n` flag.** This report attributes the
>   `terminal-bench/terminal-bench@latest -k 5 --agent oracle` command to the README at `2b0442c`.
>   That commit's README is branded Frontier-Bench and runs `frontier-bench/frontier-bench` with
>   `-n 5`. In Harbor, `-n` is `--n-concurrent`, the number of trials running at the same time; it
>   repeats nothing. Repeated attempts are `-k`, `--n-attempts`. The `-k 5` command quoted below is
>   valid Harbor usage and matches the Terminal-Bench 4.0.0 README, but a reader who follows the
>   `2b0442c` link sees `-n 5`. ADR 0005 §7 lists each flag's meaning with its Harbor source line.
>
> The Harbor trial behaviors ADR 0005 relies on were rechecked at both Harbor versions.

## Decision

**Recommendation / inference:** Integrate Coding Agent as a standalone agent in the current
Harbor-backed Terminal-Bench workflow. The target is an unattended, headless Coding Agent
launcher that Harbor can install and run inside each task environment, with each task producing
Harbor-compatible reward and result artifacts. This ticket does not require a Pi adapter or a
score comparison: report Coding Agent's own per-task rewards and aggregate results for the
explicitly pinned task set only.

This recommendation follows Terminal-Bench's current architecture: the benchmark is distributed
as a Harbor dataset, and the official run examples invoke `harbor run` with an agent, model,
concurrency, and environment provider. See the [current Terminal-Bench README](https://github.com/harbor-framework/terminal-bench/blob/2b0442c/README.md)
and the [Harbor Terminal-Bench tutorial](https://www.harborframework.com/docs/tutorials/running-terminal-bench).

## Research basis and version pins

The primary pinned baseline researched for implementation is:

- **Terminal-Bench 3.0.0, commit `2b0442c`**, the release that describes the initial 74-task
  TB3.0 dataset: [release](https://github.com/harbor-framework/terminal-bench/releases/tag/v3.0.0).
- **Harbor 0.21.0, commit `64afbbc`**, the latest Harbor release observed during this research:
  [release](https://github.com/harbor-framework/harbor/releases/tag/v0.21.0).

The report also inspected the official repositories' `main` source as of 2026-08-16 for lifecycle
and schema details. The visible current-main tips were Terminal-Bench `d435a67` ([commit history](https://github.com/harbor-framework/terminal-bench/commits/main))
and Harbor `9dd349f` ([commit history](https://github.com/harbor-framework/harbor/commits/main));
they are ahead of the release tags. Reproducible implementation work should therefore use the
release pins (or an immutable Harbor Hub/package digest), not `@latest`. Terminal-Bench itself
describes the benchmark as evolving continuously, and its README currently demonstrates the
`terminal-bench/terminal-bench@latest` form ([README](https://github.com/harbor-framework/terminal-bench/blob/2b0442c/README.md)).

This research targets Terminal-Bench 3 / Harbor. The older Terminal-Bench 1 repository and its
legacy `tb run`/`task.yaml` protocol are a separate, redirected repository and should not be
mixed into this integration: [Terminal-Bench 1 repository](https://github.com/harbor-framework/terminal-bench-1).

## Requirements

### 1. Evaluation command and environment provider

Terminal-Bench's official current README installs Harbor with the Modal extra and runs a dataset
through Harbor, for example:

```sh
uv tool install 'harbor[modal]'
uv run harbor run -d terminal-bench/terminal-bench@latest \
  -k 5 --agent oracle --n-concurrent 500 --env modal
```

The same README shows a real agent invocation with `--agent`, `--model`, provider/model
configuration, concurrency, and a selected environment provider ([official README](https://github.com/harbor-framework/terminal-bench/blob/2b0442c/README.md)).
Harbor's run documentation defines `-d` as a dataset/task collection and supports local task
paths with `-p`; the resolved run creates a job containing trials ([Harbor run-evals documentation](https://www.harborframework.com/docs/run-jobs/run-evals)).

**Requirement:** provide a Harbor-invokable agent name or import path and a headless launcher;
the launcher must not depend on a person typing into a terminal during a trial. **Recommendation /
inference:** use Modal for the first full run if the team wants the published TB3 path, while
keeping Docker as a local smoke-test backend. This is an operational recommendation, not a
claim that Modal is the only valid provider: Harbor supports local Docker and cloud backends
([Harbor README](https://github.com/harbor-framework/harbor/blob/64afbbc/README.md)).

### 2. Task environment and container assumptions

Each benchmark task supplies an instruction, an environment container, and tests/verifier logic;
Harbor describes these as the core components of a task ([Harbor core concepts](https://www.harborframework.com/docs/core-concepts)).
The Terminal-Bench task layout includes `instruction.md`, `task.toml`,
`environment/Dockerfile`, `solution/solve.sh`, and `tests/test.sh`, with optional test-container
files ([Terminal-Bench contribution guide](https://github.com/harbor-framework/terminal-bench/blob/main/CONTRIBUTING.md)).

The agent container is isolated from the solution and tests. Terminal-Bench's task guidance says
not to copy the solution or tests into the agent image; the oracle solution is mounted at
`/solution`, while tests execute in a verifier environment. The verifier can be separate and is
required to be separate for the TB3 task layout ([Terminal-Bench contribution guide](https://github.com/harbor-framework/terminal-bench/blob/main/CONTRIBUTING.md)).

The Harbor task schema makes the following runtime controls explicit: Linux is the default OS,
the environment has CPU, memory, storage, optional GPU/GPU-type, build timeout, working directory,
environment variables, healthcheck, and network-mode settings. Network mode can be public,
no-network, or allowlisted; the older `allow_internet` field is a deprecated compatibility alias
([Harbor task configuration source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/models/task/config.py)).
The benchmark's current contribution guide explicitly calls Terminal-Bench an open-internet
benchmark, so disabling network is not a valid general difficulty condition ([Terminal-Bench contribution guide](https://github.com/harbor-framework/terminal-bench/blob/main/CONTRIBUTING.md)).

TB3 adds GPU resource containers and multi-container tasks. A GPU task declares a GPU count and
type; the contribution guide currently describes TB3 GPU tasks as limited to a single H100
([Terminal-Bench contribution guide](https://github.com/harbor-framework/terminal-bench/blob/main/CONTRIBUTING.md)).
Coding Agent must therefore tolerate arbitrary task-declared resources and must not assume that
the host checkout, a particular current directory, or an interactive shell is available.

**Recommendation / inference for this repo:** keep the core Bun/TypeScript agent provider-neutral,
and add a thin Harbor adapter/launcher outside `packages/ai` (for example, a future evaluation
package or a small Python integration layer). The adapter should install or copy an exact Coding
Agent artifact into the task container, expose only the required provider credentials and config,
and invoke the CLI in non-interactive mode. This boundary follows Harbor's Python agent API and
avoids coupling the model abstraction to the benchmark harness.

### 3. Agent protocol

Harbor has two relevant integration shapes:

| Shape | Required interface | Fit for Coding Agent |
| --- | --- | --- |
| External agent | Implement `BaseAgent.name()`, `version()`, `setup(environment)`, and `run(instruction, environment, context)`; populate the context while running where possible ([BaseAgent source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/agents/base.py#L156-L208)). | Useful if Coding Agent remains an externally managed process. |
| Installed agent | Implement `BaseInstalledAgent.install(environment)` and the agent's run method; use root execution for system installation and agent-user execution for user-level setup ([BaseInstalledAgent source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/agents/installed/base.py#L289-L390)). | **Recommended / inference:** best fit for a CLI that must execute inside the task container. |

For an installed agent, Harbor creates the installed-agent directory, runs `install`, and then
invokes the agent in the prepared environment. The base implementation exposes separate
`exec_as_root` and `exec_as_agent` helpers and raises on failed commands ([BaseInstalledAgent source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/agents/installed/base.py#L289-L390)).
The Coding Agent adapter should install Bun and the exact agent artifact only as needed, then
launch the CLI with the task instruction and provider/model configuration.

The agent phase receives an instruction, an environment, and an agent context. Harbor wraps that
phase in the configured agent timeout and then downloads agent logs ([trial lifecycle source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/trial/trial.py#L470-L558)).
The task's agent timeout is a task-configured value; it is not safe to assume an unlimited process
or a single fixed global timeout ([task configuration source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/models/task/config.py)).

**Minimum protocol for Coding Agent:** accept the task instruction, operate through the provided
container environment, finish or fail without human intervention, return control before the
configured timeout, and leave any task outputs in the task/container paths that the verifier can
read. **Recommendation / inference:** stream or periodically persist an execution transcript and
populate token/cost metadata when the provider exposes it; this makes failures diagnosable even
when the reward is zero.

### 4. Trial lifecycle

The Harbor single-step lifecycle is the practical contract for a normal Terminal-Bench task:

1. Harbor resolves/downloads the task and creates the trial configuration and result skeleton.
   The result records the task checksum, task ID, agent information, configuration, and timing
   metadata ([trial source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/trial/trial.py#L132-L194)).
2. Harbor prepares the agent environment, runs health checks, uploads configured skills, and
   performs agent setup under the configured default user ([trial source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/trial/trial.py#L238-L319)).
3. Harbor runs the agent with the task instruction and context under the agent timeout and the
   configured network policy, then downloads logs ([trial source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/trial/trial.py#L470-L558)).
4. Harbor collects declared artifacts. In separate-verifier mode, it tears down/stops the agent
   environment before building/running the verifier environment ([single-step trial source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/trial/single_step.py#L70-L152)).
5. The verifier runs with its own timeout, reads the permitted artifacts, writes reward output,
   and Harbor finalizes the trial, tears down environments, and writes the result ([trial source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/trial/trial.py#L560-L730)).

Harbor also supports multi-step trials: steps run sequentially against a shared environment, each
step can have preparation, agent execution, artifact collection, and verification, and a
`min_reward` can stop later steps; the aggregate is calculated from step results ([multi-step trial source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/trial/multi_step.py)).
Coding Agent should not bake in a single-step assumption even if the initial TB3 task subset is
mostly single-step.

### 5. Verifier contract and result format

The verifier is the source of the task reward. Harbor's task documentation requires
`tests/test.sh` to write either a scalar to `/logs/verifier/reward.txt` or a JSON map of numeric
metrics to `/logs/verifier/reward.json`; Harbor reads the JSON form and falls back to text
([Harbor task documentation](https://www.harborframework.com/docs/tasks)).

In separate-verifier mode, the verifier receives declared artifacts and the contents of
`/logs/artifacts`; agent and verifier logs are not automatically transferred unless explicitly
declared as artifacts ([Harbor task documentation](https://www.harborframework.com/docs/tasks)).
The agent must therefore write task deliverables to the paths described by the task and must not
assume that its private working directory will remain available to the verifier.

Harbor writes a host-side trial directory containing, among other files, `config.json`,
`lock.json`, `result.json`, agent/verifier directories, an artifact manifest, and trial logs. The
container-side paths include `/logs/agent`, `/logs/verifier`, `/logs/artifacts`, `/tests`, and
`/solution` ([Harbor trial paths source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/models/trial/paths.py)).
The current source names the canonical result file `result.json`; a documentation example has
also used `results.json`, so integrations should follow the pinned source version rather than
hard-code the plural spelling.

The structured `TrialResult` includes task/trial identity, task checksum, resolved configuration,
agent info, agent result/context, verifier result, verifier environment mode, exception details,
timestamps, timings, and optional step results ([TrialResult source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/models/trial/result.py)).
The verifier result's `rewards` field is a map of numeric reward values ([VerifierResult source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/models/verifier/result.py)).

ATIF is Harbor's standard trajectory format for user/agent/tool/environment events. The current
RFC specifies a JSON document with required agent and steps, sequential step IDs, source/message
fields, and optional tool calls, observations, metrics, and extra data ([ATIF RFC](https://github.com/harbor-framework/harbor/blob/64afbbc/rfcs/0001-trajectory-format.md)).
Harbor's trajectory documentation says integrated agents may write
`/logs/agent/trajectory.json`, and provides a validator command ([trajectory documentation](https://www.harborframework.com/docs/agents/trajectory-format)).

**Requirement versus recommendation:** Harbor's reward/result files are the minimum contract for
an evaluation run. **Recommendation / inference:** emit a valid ATIF trajectory as an audit
artifact and fill `AgentContext` token, cost, rollout, and metadata fields when available
([AgentContext source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/models/agent/context.py)).
ATIF improves debugging and later analysis; this research found no source requirement that a
standalone Coding Agent trial must compare its ATIF or reward against Pi.

### 6. Reproducibility requirements

Harbor's lock model records the resolved task name/version, task content digest, source/path or
Git URL and commit, task configuration, agent configuration, environment/verifier configuration,
and Harbor package version/commit when available ([Harbor lock model source](https://github.com/harbor-framework/harbor/blob/64afbbc/src/harbor/models/job/lock.py)).
That lock is the strongest first-party basis for a repeatable run.

**Recommendation / inference:** record and preserve all of the following with the evaluation:

- Terminal-Bench dataset/package tag and immutable digest or commit; use TB3.0.0 rather than
  `@latest` for the baseline.
- Harbor version and commit; use Harbor 0.21.0 / `64afbbc` for the baseline, with Python 3.12 or
  newer as required by Harbor's package metadata ([Harbor pyproject](https://github.com/harbor-framework/harbor/blob/64afbbc/pyproject.toml)).
- Coding Agent artifact version and source commit, Bun version, adapter version, and exact
  provider/model identifier.
- Environment backend, base image digest, CPU/memory/storage/GPU declarations, network mode,
  workdir, timeout values, retry policy, concurrency, and attempt count.
- Non-secret configuration and environment-variable names; never place API keys in the report or
  committed artifacts.
- The complete Harbor job directory, especially `config.json`, `lock.json`, every trial's
  `result.json`, verifier reward files, logs, artifact manifests, and agent trajectory.

Harbor's adapter guidance recommends pinning the Harbor commit, agent version, Docker base image,
environment variables, and run configuration when parity matters ([Harbor adapter documentation](https://www.harborframework.com/docs/datasets/adapters)).
That guidance is directly applicable as a reproducibility recommendation even though CDA-21 does
not require a parity experiment.

The official Terminal-Bench contribution guide asks task authors to make task quality robust
across time and hardware subject to declared resource requirements, and the official README
recommends multiple oracle runs in its current run example ([contribution guide](https://github.com/harbor-framework/terminal-bench/blob/main/CONTRIBUTING.md), [README](https://github.com/harbor-framework/terminal-bench/blob/2b0442c/README.md)).
**Recommendation / inference:** first run the official oracle repeatedly on the same pinned task
set/backend as a harness sanity check; then run a small Coding Agent smoke subset before the full
fixed evaluation. Repeated agent trials are useful for measuring variance but are an experiment
design choice, not a discovered Terminal-Bench requirement.

## Recommended implementation boundary for this repository

1. Add a Harbor-facing installed-agent adapter/launcher rather than putting Harbor-specific
   imports into `packages/ai`.
2. Package Coding Agent as an immutable, installable artifact. The adapter's `install` phase should
   provision the exact runtime and artifact; its `run` phase should invoke the CLI headlessly with
   the supplied instruction.
3. Make the launcher robust to task-specific current directories, public network access, resource
   limits, and separate verifier teardown. Write only intended task outputs and declared logs.
4. Produce Harbor's native results and rewards, plus a valid ATIF trajectory and useful context
   metadata when possible.
5. Keep the evaluation command/configuration in the evaluation layer and preserve the generated
   Harbor job directory. Summarize Coding Agent's own reward distribution and failures; do not add
   a Pi score comparison or assume Pi's protocol is the benchmark contract.

These are repo-design recommendations/inferences derived from the Harbor interfaces and the
current Terminal-Bench task lifecycle; they are not additional Terminal-Bench source mandates.

## Important uncertainties and version-sensitive areas

- **Moving benchmark:** Terminal-Bench is explicitly evolving, and current main is ahead of the
  v3.0.0 release. `terminal-bench/terminal-bench@latest` may change task membership, task versions,
  schemas, or resource requirements. Pin a release/package digest and retain the Harbor lock.
- **Documentation drift:** Harbor's public tutorial still shows Terminal-Bench 2 naming in places,
  while the current Terminal-Bench repository is organized around TB3. Confirm the exact Harbor Hub
  dataset identifier and tag available at implementation time; do not infer it from a TB2 example
  ([Harbor Terminal-Bench tutorial](https://www.harborframework.com/docs/tutorials/running-terminal-bench), [current Terminal-Bench README](https://github.com/harbor-framework/terminal-bench/blob/2b0442c/README.md)).
- **Release versus main:** Harbor 0.21.0 is the pinned release, but the inspected main branch is
  newer. Source-level lifecycle details should be rechecked if implementation uses a later commit.
- **Backend behavior:** Docker, Modal, and other Harbor environments can differ in image caching,
  network policy, available hardware, and scheduling. Treat backend and image digest as part of the
  evaluation identity.
- **Task lifecycle diversity:** Harbor supports both single-step and multi-step trials, separate
  verifiers, and multi-container/GPU tasks. A launcher tested only on one simple task may not cover
  the current or future dataset.
- **Result naming:** The pinned Harbor source uses `result.json`, while a documentation example
  uses `results.json`. Consume the source-versioned path and preserve the whole job directory rather
  than relying on a guessed filename.
- **Credential and model variance:** Provider outages, model revisions, hidden provider defaults,
  and rate limits can change outcomes. Record model/provider IDs and non-secret configuration, and
  make retries/concurrency explicit.

## Source-quality summary

All substantive findings above use first-party sources: the official Terminal-Bench repository and
release, the official Harbor repository/release/source files, and Harbor's official documentation
and ATIF RFC. The most authoritative details are the commit-pinned Harbor Python models and trial
implementation plus Terminal-Bench's official task/contribution guidance. The only deliberate
inferences are the proposed adapter shape, pinning/experiment procedure, ATIF as an audit artifact,
and repository boundary; each is labeled as a recommendation/inference. No third-party benchmark
comparisons or Pi score claims were used.
