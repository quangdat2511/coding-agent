# Evaluation Dataset as a Job Parameter

Status: accepted

Date: 2026-11-17

## Context

[Make the evaluation dataset a per-job parameter](https://datn-fit-hcmus.atlassian.net/browse/CDA-114)
asks that the dataset a TerminalBench job runs be a property of the job rather than a constant of
the evaluation protocol, and that every count a record reports be derived from that job's task list.

[The TerminalBench evaluation protocol](./0005-terminalbench-evaluation-protocol.md) §1 pins one
dataset with its task count, and the count becomes the protocol's denominator in §8's mean and in
its Consequences.
[The implementation order](./0006-implementation-order-and-mvp-completion-checklist.md) §6 item 11
and [the provider and model record](./0007-evaluation-provider-and-model.md) repeat the pin and the
count. The runner is wider than the protocol. Harbor accepts any registered dataset through
`-d <name>@<version>`
([`cli/jobs.py` L1102](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L1102)),
stores the resolved dataset name and reference in the job configuration
([`models/job/config.py` L24](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/job/config.py#L24)),
and records every resolved task's identity and content digest in the job's `lock.json`
([`models/job/lock.py` L66](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/job/lock.py#L66)).
A protocol that names one dataset is therefore narrower than the harness it runs on.

Four problems follow from a fixed pin. Adding or changing a dataset means editing several records
and hoping none was missed. The task count is a property of one release, not of the protocol, so a
job on another dataset would inherit a denominator that does not describe it. The smoke task names
are likewise release data: they exist because that release contains tasks with the right shape, and
a later release need not contain them. And nothing in the protocol stops two jobs on different
pins from being reported as one result, even though their tasks and verifiers differ.

The pin itself has moved since ADR 0005. Version 4.0.0 was released on 2026-08-26. Version 4.1.0
was published on 2026-11-03 at tag `v4.1.0`, commit `4070d6cef56a7d20cb5dc98d5e10ada88a6b9440`. Its
[release notes](https://github.com/harbor-framework/terminal-bench/releases/tag/v4.1.0) report that
no task was added or removed and that the release changes verifiers only, for verifier fixes,
reproducibility, and hardening against reward hacking. Its
[release blog](https://www.tbench.ai/news/terminal-bench-4-1) states that minor releases make no
agent-facing changes in the environments, that re-grading the 4.0.0 leaderboard with the 4.1.0
verifiers kept all 35 agents' scores within their previously reported 95% confidence intervals, and
that about 1.16% of 11,550 re-graded trials changed score. The same release publishes a CPU-only
dataset, `terminal-bench/terminal-bench-cpu@4.1.0`, with 63 tasks.

The facts this record relies on were read in source at `4070d6c` and are listed under Evidence.
Every task in the release declares a separate verifier environment and a 28,800 s agent timeout,
has no `steps`, and has an environment Dockerfile; eleven tasks also have a Compose file; three
declare one H100 GPU each; and the three CPU-only single-container tasks that §4 records as the
smoke set still exist. The dataset's task count is a property of the release, so it is derived per
job and not repeated in this record's normative text.

## Decision

### 1. The dataset is a per-job parameter

Every Harbor job under this protocol names its dataset with `-d <name>@<version>`. The protocol
fixes one default pin (§2) and no other dataset: for a job, no rule, task count, release commit, or
smoke task comes from the protocol rather than from the dataset it names. A recorded job's manifest
records what it actually ran. Every job requires an explicit registry version: this protocol refuses
`latest`, an unversioned name, and a local path, because none of them fixes the task list.

The default pin's dataset data is §4. Any other dataset records the same fields, with the evidence
for §3's properties, in a committed file at
`evaluation/terminalbench/datasets/<org>/<name>@<version>.md` before the first job that names it; the
file has the fields and evidence §4's table shows. A job whose dataset has no such record is not
admissible.

A recorded job's `manifest.json` records its dataset: the identifier, the source repository and
release tag, the resolved release commit, the task count, the resolved task list, and the smoke task
names the smoke job used. Those values are recorded per job, not fixed by this record's rules. The
identifier, count, and list come from the job's resolved task list. The release commit is resolved
from the dataset's release tag in its source repository; the dataset data records the repository and
tag. The manifest records both the values and how they were resolved. Harbor's `config.json` already
carries the dataset name and reference that Harbor resolved, and `lock.json` carries each task's
identity and digest, so the record can be checked against the job rather than against a constant.

The manifest derives `N` from the job's resolved task list. A recorded job has no task filtering
(ADR 0005 §7), so that list is the dataset's task list. A rerun job selects tasks with `-i`, but `N`
stays the recorded job's count, and each selected task's rerun outcome substitutes for its original.
`report.md` states the dataset identifier, the release commit and `N`, and computes the mean over
the recorded job's `N` outcomes, counting a trial without a reward as zero, as Harbor's `mean` does.
A report whose job is invalid under ADR 0005 §7 publishes no headline reward, so `N` is never used
to present a partial result.

Results are comparable only within one dataset pin and are never pooled across pins. A job on
another admissible dataset is a separate experiment with its own manifest and report; it is not an
amendment to this record and not a relabelling of another pin's result.

### 2. The default pin

The MVP's recorded job runs `terminal-bench/terminal-bench@4.1.0`, release commit
`4070d6cef56a7d20cb5dc98d5e10ada88a6b9440`.

Version 4.1.0 is the release its maintainers currently publish, which is exactly ADR 0005 §1's
ground for 4.0.0. Its task list is unchanged, so the reason that record chose 4.0.0 still holds;
its verifier fixes harden the grading against reward hacking that 4.0.0's verifiers leave open; and
the re-grade stayed within 4.0.0's confidence intervals, so moving the default does not silently
change what the benchmark measures. 4.0.0 remains a valid pin: results reported under it are
comparable only with each other, and a job that runs it is a separate pin. No job has run yet
(ADR 0005's Evidence), so no result has to be relabelled.

The default pin includes GPU tasks, so the oracle job exercises the GPU path that is one reason the
recorded job's backend is Modal and not Harbor's Docker environment.

Changing this default is a new decision that amends this record. Passing a different admissible
dataset to a job does not.

### 3. Dataset properties this protocol requires

A dataset is admissible for a job under this protocol only when all of the following hold. The
manifest records the evidence for each, and a job that cannot show one is not valid under ADR 0005
§7. "Any Harbor dataset" is therefore not admissible.

1. **Image-based tasks.** Every task declares a container environment Harbor can build and run on
   the job's backend: a Dockerfile, or a Compose file whose services the backend supports. The image
   the agent runs in is glibc Linux on a target architecture the artifact was built for, because
   ADR 0005 §2's executable is a glibc-linked ELF and the adapter installs no runtime.
2. **Single-step tasks.** No task declares `steps`. The protocol describes one agent run per trial:
   ADR 0005 §4's three files, §6's `populate_context_post_run` and `trajectory.json` mapping, and
   §8's per-task report row all assume it. A multi-step task's several runs would need those rules
   extended first.
3. **A separate verifier environment.** Every task's verifier runs in its own environment, built
   from the task's tests. ADR 0005 §5 configures no verification command for the agent, so this is
   the only grading path; a shared verifier environment would expose tests to the agent and change
   the trial.
4. **A per-task agent timeout at least as large as the session.** Every task's declared agent
   timeout is at least the `terminalbench` profile's 3,600,000 ms `maxDurationMs`, so Coding Agent
   settles inside its own session and writes `result.json` instead of being cancelled by Harbor
   from outside.
5. **A smoke set.** The dataset contains at least three CPU-only, single-container tasks with small
   resource requests, so the smoke job of ADR 0005 §7 can run before any credential-carrying job.

A dataset that satisfies these properties is still subject to ADR 0005 §7's credential-isolation
precondition, which is a property of the artifact and the backend, not of the dataset.

### 4. Dataset data at the default pin

This section is the default pin's dataset record and is data, not protocol: another pin records its
own file (§1) without changing §1 to §3, and only a new default pin changes §2.

| Item | Value at the default pin |
| --- | --- |
| Dataset identifier | `terminal-bench/terminal-bench@4.1.0` |
| Source repository | `https://github.com/harbor-framework/terminal-bench` |
| Release tag | `v4.1.0` |
| Release commit | `4070d6cef56a7d20cb5dc98d5e10ada88a6b9440` |
| Task count | the release's task list; `N` is derived per job and recorded in the manifest, and this record fixes no task count |
| Environment | a Dockerfile per task; eleven tasks also have a Docker Compose file |
| Single step | every task |
| Verifier environment | separate, every task |
| Per-task agent timeout | 28,800 s |
| GPU tasks | `fp8-rmsnorm-gemm`, `jax-speedrun-gpu`, `math-eval-grader`, one H100 each |
| Smoke tasks | `bun-sourcemap-leak`, `music-harmony`, `photonic-waveguide-routing` |
| Tasks with declared MCP servers | `medical-claims-processing`, one MCP server |
| Tasks with a declared skills directory | `cumulative-layout-shift` |
| Tasks with whole `/app` verifier artifacts | `coq-block-bound`, `jax-speedrun-gpu`, `ks-solver-cpp`, `risk-scorer-replay`, `vf2-speedup-networkx`, `wal-recovery-ordering` |

The three smoke tasks are CPU-only, single-container, small-resource tasks (2 CPUs, 4 GiB of memory,
10 GiB of storage, no GPU), with a separate verifier and the standard 28,800 s agent timeout. The
smoke job therefore costs little and still exercises the adapter end to end. Which three tasks are
the smoke set is data: another dataset records its own set, chosen by the same properties. The names
live in this table, not in ADR 0005 §7.

The dataset at 4.0.0 remains identifiable by its own release commit, `452bf30`, which ADR 0005's
Context records. Its task list is the same as 4.1.0's; its verifiers are the ones 4.1.0 replaced.

On 2026-11-21, [CDA-93](https://datn-fit-hcmus.atlassian.net/browse/CDA-93) added the MCP-server and
skills-directory rows to this table. They name the tasks whose declared MCP servers or skills
directory the adapter ignores, which the recorded job's report must name (ADR 0005 §5 and §8); the
rows change no other data. The record tooling reads these rows, so a dataset whose record has no
such row reports that no task declared one.

### 5. What changes in the records

This decision amends, with dated notes:

- [ADR 0005](./0005-terminalbench-evaluation-protocol.md) §1, whose dataset row now names a job
  parameter and a default rather than one dataset for every job; §5, which states the session bound
  in terms of an admissible dataset; §7, whose two commands take `<dataset>`, whose smoke set is
  dataset data, and whose validity rule includes this record's §3 properties; §8, whose manifest
  records the dataset and whose mean derives `N`; and its Consequences, whose per-job compute count
  follows the job's task list.
- [ADR 0006](./0006-implementation-order-and-mvp-completion-checklist.md) §6 item 11, whose one
  paid oracle job pays for the job's dataset rather than a fixed set of environments.
- [ADR 0007](./0007-evaluation-provider-and-model.md), whose per-job cost arithmetic is anchored
  to the default pin rather than to a protocol constant.

It also makes the dataset an explicit input of the record tooling and of the F2 adapter: the
dataset comes from the job configuration, not from an assumed pin, and no test may hardcode a
dataset name, version, or task count.

## Evidence behind this record

**Read in source.** Harbor was read at `1e5c5c6` (the 0.23.0 pin of ADR 0005 §1), Terminal-Bench at
the `v4.1.0` tag, which resolves to `4070d6cef56a7d20cb5dc98d5e10ada88a6b9440`.

| Statement | Source |
| --- | --- |
| `-d <name>@<version>` is the dataset parameter, and `-i` filters its tasks | [`cli/jobs.py` L1102](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L1102), [L1152](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/cli/jobs.py#L1152) |
| The resolved dataset name and reference are part of the job configuration | [`models/job/config.py` L24](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/job/config.py#L24) |
| The job's `lock.json` records every task's name, version, type and content digest; a Git task also records its source commit | [`models/job/lock.py` L66](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/job/lock.py#L66), [L266](https://github.com/harbor-framework/harbor/blob/1e5c5c6/src/harbor/models/job/lock.py#L266) |
| `v4.1.0` resolves to commit `4070d6c` | [`git/ref/tags/v4.1.0`](https://api.github.com/repos/harbor-framework/terminal-bench/git/ref/tags/v4.1.0) |
| 4.1.0 adds and removes no task; it changes verifiers only; it publishes a CPU-only dataset with 63 tasks | [release notes](https://github.com/harbor-framework/terminal-bench/releases/tag/v4.1.0) |
| Minor releases make no agent-facing environment changes; the 4.0.0 leaderboard re-graded within its 95% confidence intervals | [release blog](https://www.tbench.ai/news/terminal-bench-4-1) |
| At the default pin every task is single-step, declares a separate verifier environment and a 28,800 s agent timeout, and has a Dockerfile; eleven tasks also have a Compose file | every `task.toml` and `environment/` under [`tasks/`](https://github.com/harbor-framework/terminal-bench/tree/v4.1.0/tasks), parsed by script |
| The GPU tasks are `fp8-rmsnorm-gemm`, `jax-speedrun-gpu` and `math-eval-grader`, at one H100 each | their `task.toml` under the same tag |
| The three smoke tasks exist, are CPU-only, single-container, and use the standard verifier and timeout | their `task.toml` under the same tag |
| The tasks with whole `/app` verifier artifacts are the same at 4.1.0 as at 4.0.0 | their `task.toml` `artifacts` under [`tasks/`](https://github.com/harbor-framework/terminal-bench/tree/v4.1.0/tasks), parsed by script |

**Not executed.** No Harbor job has run, so the registry resolution, the job configuration and the
`lock.json` facts are read in source rather than observed in a finished job. The smoke job is the
first point at which they are checked, and the recorded job's manifest is the first to record a
resolved dataset.

## Considered options

- **Keep the dataset in the protocol and edit the count when it changes.** This is the state the
  ticket exists to remove. It is rejected because a count that appears in several records is edited
  in several places, and a record that misses one publishes a wrong denominator.
- **Keep 4.0.0 as the default.** Rejected: it is no longer the release the maintainers publish, its
  verifiers keep the reward-hacking paths 4.1.0 fixes, and keeping it would leave ADR 0005 §1's own
  ground for choosing it false.
- **No default pin.** Rejected: the MVP's recorded job must be reproducible and comparable to a
  named benchmark, and a protocol with no default would make the one required job an open choice.
  A job parameter with one declared default is the narrow rule: the default is a decision, the
  parameter is routine.
- **`latest` or an unversioned name.** Rejected: either can change the task list without changing
  anything the manifest records.
- **`terminal-bench-cpu@4.1.0` as the default.** Rejected: it has no GPU task, so the oracle job
  would not exercise Modal's GPU path; its task list is also smaller, so its results would not
  describe the full benchmark.
- **Pool 4.0.0 and 4.1.0 results.** Rejected: the re-grade is within 4.0.0's confidence intervals,
  but the pins differ, and a pooled mean would describe neither release. A report names one pin.
- **Admit any Harbor dataset.** Rejected: a dataset without the five properties can fail for
  reasons outside the agent, which the protocol's validity and rerun rules would then misreport.

## Consequences

- `N` is computed from the job's task list, so a dataset change is a job configuration change, not a
  protocol edit. Only changing the default is a decision.
- ADR 0007's per-job cost figures are anchored to the default pin. A job on another dataset costs
  in proportion to its task list and GPU tasks, and its result is a separate experiment.
- The five dataset properties become a gate before a job's headline result is published. A job that
  cannot show them is reported as invalid rather than as a benchmark result.
- The default pin's data lives in §4, so the smoke task names and the GPU task names can change with
  a dataset without touching the protocol's normative text.
- The default pin moves to 4.1.0, so the oracle, smoke and recorded jobs of ADR 0005 §7 run that
  pin. The 4.1.0 release makes no agent-facing environment change, so the container facts ADR 0005
  records for 4.0.0 still describe it; its verifier facts are 4.1.0's own.
- Results are never pooled across pins, and every report names the pin it describes. A reader
  comparing two jobs compares their manifests, including the dataset identifier and release commit.
- A dataset whose source repository or release tag cannot be resolved for the release commit cannot
  be recorded under this protocol, because the manifest requires that commit.
