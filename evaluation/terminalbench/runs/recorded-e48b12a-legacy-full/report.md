# Recorded TerminalBench job: recorded-e48b12a-legacy-full

- Dataset pin: factory-ai/legacy-bench@v0.1
- Release commit: 12fa7cf969b7a253183388040d566fb353a1ab31
- Evaluation Profile: terminalbench
- Provider and model: opencode/deepseek-v4.1-flash
- Coding Agent artifact: 0.0.1 e48b12ad1758b2016d78c04d76f591cedfdf0098
- Validity: not valid

The report has no pass or fail threshold and no Pi column: ADR 0005 §8 makes the Harbor reward the only success measure, and a later Pi run under the same pins is outside this protocol.

## Validity

**Not valid.** ADR 0005 §7 makes a job valid only when every task has a completed trial in the recorded job or the rerun job, and the dataset has the properties ADR 0008 §3 requires. No headline reward is published. The problems are:

- trial 16b04d-cobol-railroad-retirement__w5xLjC4 of factory-ai/16b04d-cobol-railroad-retirement-migration records verifier environment mode 'shared', not 'separate'
- trial 1907c2-c-debug-legacy-buddy-fix__sVidqXY of factory-ai/1907c2-c-debug-legacy-buddy-fix records verifier environment mode 'shared', not 'separate'
- trial 2831b5-java7-rating-engine-repai__FsRng5J of factory-ai/2831b5-java7-rating-engine-repair records verifier environment mode 'shared', not 'separate'
- trial 3af1fe-cobol-bond-settlement-rec__5gfdpaj of factory-ai/3af1fe-cobol-bond-settlement-reconcile records verifier environment mode 'shared', not 'separate'
- trial 505812-java7-inventory-cost-fix__QL5vvPk of factory-ai/505812-java7-inventory-cost-fix records verifier environment mode 'shared', not 'separate'
- trial 6fe1ab-java7-mtom-attachment-cor__v7Dr5TS of factory-ai/6fe1ab-java7-mtom-attachment-corruption-fix records verifier environment mode 'shared', not 'separate'
- trial 8e8098-cobol-railcar-settlement__coNgMiW of factory-ai/8e8098-cobol-railcar-settlement-fix records verifier environment mode 'shared', not 'separate'
- trial d1ddc1-fortran-to-cpp-lattice-qc__C2WNrD7 of factory-ai/d1ddc1-fortran-to-cpp-lattice-qcd-migration records verifier environment mode 'shared', not 'separate'
- trial ecf5e7-asm-debug-mz-ne-header-fi__i9rzK9C of factory-ai/ecf5e7-asm-debug-mz-ne-header-fix records verifier environment mode 'shared', not 'separate'
- trial fac397-cobol-batch-interest-migr__xeuE6kd of factory-ai/fac397-cobol-batch-interest-migration records verifier environment mode 'shared', not 'separate'
- the dataset declares a 300 s per-task agent timeout, below the profile's 3600 s maxDurationMs
- the record waives credential isolation: every task of factory-ai/legacy-bench@v0.1 runs the agent as root on Modal, so no non-root isolation run exists for this dataset; the passing root run on Modal is recorded
- the record waives the dataset release tag: https://github.com/Factory-AI/legacy-bench publishes no Git tag; the record names the main commit the published tasks were built from
- the record waives the timeout override: the dataset caps the agent at 300 s and 720 s; the rehearsal raised the timeout 13x so Harbor never preempts the artifact's own 1 h maxDurationMs, and two trials ended at that limit

## Waivers

This record waives a requirement of ADR 0005 §7, so it does not count under §9 criterion 5 and is not the MVP's recorded job:

- **Credential isolation**: every task of factory-ai/legacy-bench@v0.1 runs the agent as root on Modal, so no non-root isolation run exists for this dataset; the passing root run on Modal is recorded
- **Dataset release tag**: https://github.com/Factory-AI/legacy-bench publishes no Git tag; the record names the main commit the published tasks were built from
- **Timeout override**: the dataset caps the agent at 300 s and 720 s; the rehearsal raised the timeout 13x so Harbor never preempts the artifact's own 1 h maxDurationMs, and two trials ended at that limit

## Dataset

The job ran factory-ai/legacy-bench@v0.1, whose source repository is https://github.com/Factory-AI/legacy-bench and whose record names commit 12fa7cf969b7a253183388040d566fb353a1ab31. The record waives resolving that commit from a release tag: https://github.com/Factory-AI/legacy-bench publishes no Git tag; the record names the main commit the published tasks were built from.

N is 10, the number of tasks in the job's resolved task list, not a constant: ADR 0008 makes the dataset a job parameter and derives every count from the job.

Its result is comparable only with jobs on factory-ai/legacy-bench@v0.1, and is never pooled with the result of another dataset pin.

The dataset's own data comes from its committed record, evaluation/terminalbench/datasets/factory-ai/legacy-bench@v0.1.md; manifest.json copies the record's rows and the evidence for the properties ADR 0008 §3 requires.

Smoke set: ecf5e7-asm-debug-mz-ne-header-fix, 1907c2-c-debug-legacy-buddy-fix, 505812-java7-inventory-cost-fix.

| Property | Evidence | Shown |
| --- | --- | --- |
| Environment | a Dockerfile per task (ubuntu:24.04, python:3.13-slim-bookworm, and similar); no task has a Docker Compose file | yes |
| Single step | every task | yes |
| Verifier environment | shared: no task declares [verifier.environment], so the verifier runs in the agent's container, and ADR 0008 §3 property 3 does not hold for this dataset | yes |
| Per-task agent timeout | 300 s for nine tasks and 720 s for fac397-cobol-batch-interest-migration, so ADR 0008 §3 property 4 does not hold for this dataset | yes |

## Result

**No headline reward:** the job is not valid (ADR 0005 §7).

For diagnosis only, the mean over the 10 recorded outcomes is 0.9, counting a trial without a verifier reward as 0.

## Reward distribution

| Recorded reward | Tasks |
| --- | --- |
| 0 | 1 |
| 1 | 9 |

## Per-task results

| Task | Reward | Source | Agent Result | Failure code | Model Turns | Tool Calls | Input tokens | Cache tokens | Output tokens | Duration (s) | Trial exception |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| factory-ai/16b04d-cobol-railroad-retirement-migration | 1 | recorded | succeeded | — | 109 | 128 | 7826862 | 7705984 | 332185 | 3362.8 | — |
| factory-ai/1907c2-c-debug-legacy-buddy-fix | 1 | recorded | succeeded | — | 57 | 66 | 1819374 | 1765120 | 155875 | 1749.5 | — |
| factory-ai/2831b5-java7-rating-engine-repair | 1 | recorded | succeeded | — | 39 | 46 | 1537425 | 1469312 | 81231 | 728.9 | — |
| factory-ai/3af1fe-cobol-bond-settlement-reconcile | 1 | recorded | succeeded | — | 83 | 96 | 2890823 | 2827136 | 228288 | 2281.8 | — |
| factory-ai/505812-java7-inventory-cost-fix | 1 | recorded | succeeded | — | 86 | 96 | 3876852 | 3794304 | 158247 | 1636.4 | — |
| factory-ai/6fe1ab-java7-mtom-attachment-corruption-fix | 1 | recorded | succeeded | — | 68 | 80 | 2571110 | 2503552 | 112862 | 1125.1 | — |
| factory-ai/8e8098-cobol-railcar-settlement-fix | 1 | recorded | failed | LIMIT_EXCEEDED | 89 | 109 | 5775717 | 5668096 | 363338 | 3602.0 | — |
| factory-ai/d1ddc1-fortran-to-cpp-lattice-qcd-migration | 1 | recorded | succeeded | — | 54 | 58 | 1912840 | 1854720 | 66704 | 678.3 | — |
| factory-ai/ecf5e7-asm-debug-mz-ne-header-fix | 0 | recorded | failed | LIMIT_EXCEEDED | 20 | 26 | 362339 | 331008 | 335232 | 3601.9 | — |
| factory-ai/fac397-cobol-batch-interest-migration | 1 | recorded | succeeded | — | 60 | 77 | 2529202 | 2454016 | 191293 | 2016.6 | — |

## Agent Result against reward

| Agent Result | 0 | 1 |
| --- | --- | --- |
| failed | 1 | 1 |
| succeeded | 0 | 8 |

## Rerun-eligible trials

None. Every trial has a verifier reward and no MODEL_FAILURE whose details record an HTTP 401, 403, 429 or 5xx from the provider (ADR 0005 §7).

## Harness-flaky tasks

From the oracle job oracle-e48b12a-legacy (ADR 0005 §7 step 2).

None. Every task's oracle reward is 1.

## Ignored MCP servers and skills

None recorded in the dataset record.
