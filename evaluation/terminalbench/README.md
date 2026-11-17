# TerminalBench adapter

This directory is the Harbor adapter of
[ADR 0005 §6](../../docs/adr/0005-terminalbench-evaluation-protocol.md). Harbor is the harness
that runs TerminalBench. The adapter is the Harbor agent that runs the Coding Agent artifact in each
task container. It is the only Python project in the repository. It is not a Bun workspace package,
so Biome, the import boundary check, `bun --filter`, and `bun test` do not check it.

The adapter uses Coding Agent only through its command line and the files that it writes. It
imports nothing from `packages/`.

## Pins

| Component | Pin | Source |
| --- | --- | --- |
| Python | 3.12 or newer, 3.12 in `.python-version` | ADR 0005 §1 |
| Harbor | `harbor[modal]==0.23.0`, the only direct dependency | ADR 0005 §1 and §6 |
| Everything else | `uv.lock` | ADR 0005 §1 |

The tests use the `unittest` module of the standard library, so the project adds no test runner.
The build backend `uv_build` installs the project into its environment. Harbor can then import the
agent class when `uv run --project evaluation/terminalbench` starts in the repository root.

## Commands

Install [uv](https://docs.astral.sh/uv/) 0.13.8, the version that CI uses. Then run these commands
from the repository root, like every other command in the repository. `--project` points uv at
this directory, and uv then reads its `.python-version`.

To run the tests:

```sh
uv run --project evaluation/terminalbench --frozen python -m unittest discover --start-directory evaluation/terminalbench/tests --top-level-directory evaluation/terminalbench
```

Most tests read a manifest fixture that is written by hand in `tests/support.py`. The tests in
`tests/test_built_manifest.py` read a manifest that `bun run build:artifact` wrote. They run only
when `CODING_AGENT_ARTIFACT_DIR` names its directory, and otherwise they are skipped. In CI, the
`TerminalBench adapter` job sets this variable to the manifest that the `Evaluation artifact` job
uploads. If the build changes the manifest schema and the fixture stays the same, that job fails.

To make sure that `uv.lock` matches `pyproject.toml`:

```sh
uv lock --project evaluation/terminalbench --check
```

`--frozen` installs from `uv.lock` and does not compare it with `pyproject.toml`. CI therefore runs
`uv lock --check` first, and that step fails when the lock file is out of date. If you change
`pyproject.toml`, run `uv lock` and commit `uv.lock` in the same change.

## Agent class

Harbor loads the agent from its import path, `coding_agent_terminalbench.agent:CodingAgent`. The
agent has these properties:

- It subclasses Harbor's `BaseInstalledAgent`.
- Its name is `coding-agent`.
- It declares `AgentCapabilities(atif=True)`, because it produces ATIF trajectories. ATIF is the
  trajectory format of Harbor.
- It reports the version of the artifact to Harbor.

The agent takes one kwarg, `artifact_dir`. This kwarg names the directory that
`bun run build:artifact` wrote (see `scripts/README.md`). The agent reads
`artifact-manifest.json` there when Harbor creates it. Its version is the Coding Agent version and
commit from that manifest, for example `0.0.1 64128afd1c0f27db530cf167b015d206ef67c707`. Harbor
writes this version into each trial result, so the result names the build that ran.

Harbor runs the preflight check of the agent once, before it queues the trials of a job. If the
manifest is missing or does not have the shape that `scripts/build-artifact.ts` writes, this
check stops the job. The agent refuses Harbor's `version` kwarg, because the
manifest gives the version. It refuses Harbor's `prompt_template_path` kwarg, because ADR 0005 §5
gives the agent Harbor's instruction verbatim. It also refuses Harbor's `config` kwarg, because
Coding Agent reads no native config file.

To show the kwargs that the agent accepts, run this command from the repository root:

```sh
uv run --project evaluation/terminalbench --frozen harbor agent schema coding_agent_terminalbench.agent:CodingAgent
```

`install()` and `run()` are not implemented yet, so Harbor stops the setup of every trial.
CDA-88 adds the install step, CDA-89 adds the run step, and CDA-90 adds the ATIF trajectory.
