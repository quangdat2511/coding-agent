# Recorded TerminalBench job: recorded-e48b12a-hello-modal

- Dataset pin: harbor/hello-world@1
- Release commit: 1e5c5c6db929a10a140d05e606882c671ae20729
- Evaluation Profile: terminalbench
- Provider and model: opencode/deepseek-v4.1-flash
- Coding Agent artifact: 0.0.1 e48b12ad1758b2016d78c04d76f591cedfdf0098
- Validity: not valid

The report has no pass or fail threshold and no Pi column: ADR 0005 §8 makes the Harbor reward the only success measure, and a later Pi run under the same pins is outside this protocol.

## Validity

**Not valid.** ADR 0005 §7 makes a job valid only when every task has a completed trial in the recorded job or the rerun job, and the dataset has the properties ADR 0008 §3 requires. No headline reward is published. The problems are:

- evaluation/terminalbench/datasets/harbor/hello-world@1.md names 1 smoke tasks, but ADR 0008 §3 requires at least 3
- trial hello-world__yR9PmL7 of hello-world/hello-world records verifier environment mode 'shared', not 'separate'
- the dataset declares a 120 s per-task agent timeout, below the profile's 3600 s maxDurationMs

## Waivers

This record waives a requirement of ADR 0005 §7, so it does not count under §9 criterion 5 and is not the MVP's recorded job:

- **Credential isolation**: harbor/hello-world@1 runs its single task as root on Modal, so no non-root isolation run exists for this dataset; the passing root run on Modal is recorded

## Dataset

The job ran harbor/hello-world@1, whose source repository is https://github.com/laude-institute/harbor and whose v0.23.0 tag the record says resolves to commit 1e5c5c6db929a10a140d05e606882c671ae20729.

N is 1, the number of tasks in the job's resolved task list, not a constant: ADR 0008 makes the dataset a job parameter and derives every count from the job.

Its result is comparable only with jobs on harbor/hello-world@1, and is never pooled with the result of another dataset pin.

The dataset's own data comes from its committed record, evaluation/terminalbench/datasets/harbor/hello-world@1.md; manifest.json copies the record's rows and the evidence for the properties ADR 0008 §3 requires.

Smoke set: hello-world.

| Property | Evidence | Shown |
| --- | --- | --- |
| Environment | a Dockerfile per task (ubuntu:24.04); no task has a Docker Compose file | yes |
| Single step | every task | yes |
| Verifier environment | shared: the task declares no [verifier.environment], so the verifier runs in the agent's container, and ADR 0008 §3 property 3 does not hold for this dataset | yes |
| Per-task agent timeout | 120 s, and ADR 0008 §3 property 4 does not hold for this dataset | yes |

## Result

**No headline reward:** the job is not valid (ADR 0005 §7).

For diagnosis only, the mean over the 1 recorded outcomes is 1, counting a trial without a verifier reward as 0.

## Reward distribution

| Recorded reward | Tasks |
| --- | --- |
| 1 | 1 |

## Per-task results

| Task | Reward | Source | Agent Result | Failure code | Model Turns | Tool Calls | Input tokens | Cache tokens | Output tokens | Duration (s) | Trial exception |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hello-world/hello-world | 1 | recorded | succeeded | — | 4 | 3 | 5729 | 3968 | 208 | 6.9 | — |

## Agent Result against reward

| Agent Result | 1 |
| --- | --- |
| succeeded | 1 |

## Rerun-eligible trials

None. Every trial has a verifier reward and no MODEL_FAILURE whose details record an HTTP 401, 403, 429 or 5xx from the provider (ADR 0005 §7).

## Harness-flaky tasks

From the oracle job oracle-e48b12a-hello (ADR 0005 §7 step 2).

None. Every task's oracle reward is 1.

## Ignored MCP servers and skills

None recorded in the dataset record.
