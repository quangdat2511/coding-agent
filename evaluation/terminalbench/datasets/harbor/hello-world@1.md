# Dataset data: harbor/hello-world@1

This file is the committed source of the dataset's data (ADR 0008 §1 and §4) for a job that names
`harbor/hello-world@1`. The dataset is the Harbor example task `examples/tasks/hello-world` of the
`laude-institute/harbor` repository, published to the Harbor Hub as its own package. Its rows follow
ADR 0008 §4.

| Item | Value at this version |
| --- | --- |
| Dataset identifier | `harbor/hello-world@1` |
| Source repository | `https://github.com/laude-institute/harbor` |
| Release tag | `v0.23.0` |
| Release commit | `1e5c5c6db929a10a140d05e606882c671ae20729` |
| Task count | the release's task list; `N` is derived per job and recorded in the manifest, and this record fixes no task count |
| Environment | a Dockerfile per task (`ubuntu:24.04`); no task has a Docker Compose file |
| Single step | every task |
| Verifier environment | shared: the task declares no `[verifier.environment]`, so the verifier runs in the agent's container, and ADR 0008 §3 property 3 does not hold for this dataset |
| Per-task agent timeout | 120 s, and ADR 0008 §3 property 4 does not hold for this dataset |
| GPU tasks | none |
| Smoke tasks | `hello-world` |
| Tasks with declared MCP servers | none |
| Tasks with a declared skills directory | none |

The package's `instruction.md`, `environment/Dockerfile`, `tests/test.sh` and
`tests/test_state.py` are byte-identical to the files at the tag above; the published `task.toml`
differs from the repository's copy in formatting only. The dataset therefore holds one CPU-only,
single-container task, and it is not one of the datasets ADR 0008 §3 admits for a recorded job: it
has no three-task smoke set, its agent timeout is below the `terminalbench` profile's 3,600,000 ms,
and its verifier environment is shared. A job on it is recorded as a rehearsal, not as the MVP's
recorded job.
