# Dataset data: factory-ai/legacy-bench@v0.1

This file is the committed source of the dataset's data (ADR 0008 §1 and §4) for a job that names
`factory-ai/legacy-bench@v0.1`. The dataset is Factory AI's LegacyBench, published to the Harbor Hub.
Its rows follow ADR 0008 §4.

| Item | Value at this version |
| --- | --- |
| Dataset identifier | `factory-ai/legacy-bench@v0.1` |
| Source repository | `https://github.com/Factory-AI/legacy-bench` |
| Release tag | `v0.1` |
| Release commit | `12fa7cf969b7a253183388040d566fb353a1ab31` |
| Task count | the package's task list; `N` is derived per job and recorded in the manifest, and this record fixes no task count |
| Environment | a Dockerfile per task (`ubuntu:24.04`, `python:3.13-slim-bookworm`, and similar); no task has a Docker Compose file |
| Single step | every task |
| Verifier environment | shared: no task declares `[verifier.environment]`, so the verifier runs in the agent's container, and ADR 0008 §3 property 3 does not hold for this dataset |
| Per-task agent timeout | 300 s for nine tasks and 720 s for `fac397-cobol-batch-interest-migration`, so ADR 0008 §3 property 4 does not hold for this dataset |
| GPU tasks | none |
| Smoke tasks | `ecf5e7-asm-debug-mz-ne-header-fix`, `1907c2-c-debug-legacy-buddy-fix`, `505812-java7-inventory-cost-fix` |
| Tasks with declared MCP servers | none |
| Tasks with a declared skills directory | none |

The source repository publishes no Git tag: its default branch is `main` and its tag list is empty.
The release commit above is the `main` commit that the published tasks were built from, so a job
that records this dataset waives resolving the release tag. The dataset holds ten CPU-only,
single-container tasks and is not one of the datasets ADR 0008 §3 admits for the MVP's recorded
job: it has a three-task smoke set but no separate verifier environment and no agent timeout at or
above the `terminalbench` profile's 3,600,000 ms.
