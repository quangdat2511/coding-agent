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

Most tests read fixtures that are written by hand in `tests/support.py`: the artifact manifest, and
the `run.json`, `events.jsonl` and `result.json` of a run. The tests in
`tests/test_built_manifest.py` read a manifest that `bun run build:artifact` wrote. They run only
when `CODING_AGENT_ARTIFACT_DIR` names its directory, and otherwise they are skipped. In CI, the
`TerminalBench adapter` job sets this variable to the manifest that the `Evaluation artifact` job
uploads. If the build changes the manifest schema and the fixture stays the same, that job fails.

The fixtures of a run mirror `packages/coding-agent/src/run-files.ts` and
`packages/agent-core/src/events.ts`. A change to either changes them in the same pull request: the
adapter reads those files as the external contract of ADR 0005 §4.

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

## Install step

Harbor calls `install()` during the setup of each trial. It does these steps in the task container,
in this order:

1. It reads `uname -m`. For `x86_64` it selects the `bun-linux-x64-baseline` executable of the
   manifest, and for `aarch64` the `bun-linux-arm64` executable.
2. It computes the SHA-256 of that file on the host and compares it with the manifest. Then it
   uploads the file to `/installed-agent/coding-agent`, and runs `sha256sum` on it in the
   container, so the bytes that will run are the bytes that the build hashed. Root sets the mode
   to `0755`, so every user can run the file and only root can change it.
3. It ensures `bash` through Harbor's `ensure_system_dependencies`, because the `bash` tool of
   Coding Agent needs it. If `bash` is present, nothing is installed. Nothing else is installed.
4. It runs `/installed-agent/coding-agent --version` as the user that Harbor runs the agent as.
   The output must be the version line of the manifest, for example
   `coding-agent 0.0.1 64128afd1c0f27db530cf167b015d206ef67c707`.

If a step finds a problem, it raises `ArtifactInstallError`, and Harbor fails the setup of the
trial. No trial runs. These problems fail setup:

- An architecture other than `x86_64` or `aarch64`, or a manifest without exactly one executable
  for the architecture. If `uname -m` exits 126 or 127, the image probably has no `bash`: Harbor's
  Docker and Modal environments run every command through `bash -c`.
- A missing executable, or a SHA-256 that differs from the manifest, on the host or in the
  container. If the container has no `sha256sum`, the job log has a warning, and only the host
  check runs.
- No `bash` in the container and no package manager that Harbor knows.
- A `--version` command that exits with a nonzero code, or prints a different line. Exit code 127
  usually means an image with musl libc, for example Alpine, because the executable needs glibc.

A trial that fails setup has no verifier reward. ADR 0005 §7 runs jobs with `-r 0`, so Harbor does
not retry it. The rerun job runs it once more, with the same artifact.

## Run step

`run()` follows ADR 0005 §6. It uploads Harbor's instruction, byte for byte, to
`/installed-agent/instruction.md` and gives the file to the agent user. It renders no prompt
template, and it passes no extra instruction, skill, or MCP configuration, even when the task
declares MCP servers or a skills directory. Then it runs this command, for example for
`-m opencode/deepseek-v4.1-flash`:

```sh
exec /installed-agent/coding-agent run --task-file /installed-agent/instruction.md --provider opencode --model deepseek-v4.1-flash --approval-policy auto-approve --profile terminalbench --output-dir /logs/agent/coding-agent
```

The provider and the model come from the `-m` value, split at its first `/`. A model identifier
keeps any further `/`, as in `-m openrouter/deepseek/deepseek-v4.1-flash-1017`. The output
directory is `coding-agent` under the agent log directory of the trial, which is `/logs/agent` in a
single-agent trial. The command sets no working directory and no timeout, so Coding Agent starts
where the task image places it.

Harbor runs the command through a shell that holds the provider key. The command `exec`s Coding
Agent, so that shell does not stay alive with the key, and it has no pipeline. This is the
`"auto-approve"` launch contract of ADR 0001 §8. Coding Agent's startup ancestor check refuses the
run if an ancestor still holds the key.

| Exit code | Meaning (ADR 0005 §3) | `run()` |
| --- | --- | --- |
| 0, 1, 130 | The Agent Session settled as succeeded, failed, or cancelled | Returns, and the verifier scores the trial |
| Any other | No Agent Session settled | Raises the `NonZeroAgentExitCodeError` subclass that Harbor's `exec_as_agent` would raise, and Harbor still runs the verifier |

### Provider key

The agent's environment must hold exactly one provider key: the key of the `-m` provider. Pass it
with `--ae` as a template of the host variable with the same name, so that its value is not in the
shell history (ADR 0005 §7):

```sh
--ae OPENCODE_API_KEY='${OPENCODE_API_KEY}'
```

The agent refuses the job in these cases:

- No `--ae` value names a provider key.
- `--ae` names two provider keys, for example `OPENCODE_API_KEY` and `OPENROUTER_API_KEY`, or both
  `GOOGLE_API_KEY` and `GEMINI_API_KEY`.
- The key is blank, or its value differs from the host variable with the same name. A template of
  another host variable, or a literal that differs from the host value, fails this check.
- The key belongs to another provider than the one of `-m`.

Harbor's preflight makes all of these checks except the last one before it queues a trial, because
Harbor gives preflight no model. The agent's constructor makes all of them when Harbor creates a
trial. The provider list and the key names are in `launch.py`. They match ADR 0005 §3 and
`packages/ai/src/credentials.ts`, and `tests/test_launch.py` fails if either one changes.

The agent cannot tell a template from a literal. Harbor resolves the templates before it calls
preflight or the constructor, so both receive the values only. A literal that equals the host
variable with the same name therefore passes every check, and it stays in the shell history. To
refuse every literal, a check must read `--ae` before Harbor resolves it, and Harbor 0.23.0 gives an
agent no such hook. The agent does not read the raw arguments from `sys.argv` either: a job
configuration file (`harbor run -c`) can also set the agent's environment, and `sys.argv` does not
show it, so that check would still miss a literal. CDA-89 accepts this limit.

Harbor writes each `--ae` value to the job's `config.json` in one of these forms
(`templatize_sensitive_env` in `harbor/utils/env.py`):

- A template stays as it is written.
- A literal of a sensitive variable becomes the template `${NAME}` if it equals the host variable
  `NAME`. A variable is sensitive if its name contains `KEY`, `SECRET`, `TOKEN` (but not
  `TOKENS`), `PASSWORD`, `CREDENTIAL` or `AUTH`, in any case.
- Any other literal of a sensitive variable is masked. A value of more than 8 characters keeps its
  first 4 and its last 3 characters, as in `sk-o****xyz`. A shorter value becomes `****`.
- A literal of any other variable stays as it is written.

## Trial context and trajectory

Harbor downloads the logs of a trial after its agent phase and calls `populate_context_post_run`
on the agent, but only while the `AgentContext` is empty. The adapter then reads the three files
of ADR 0005 §4 from `coding-agent/` in the downloaded logs, and fills the trial context:

- `n_input_tokens`, `n_cache_tokens` and `n_output_tokens` come from the Agent Result, or, when
  the event log is truncated because a killed process lost its tail, from the usage that each
  `model_turn_completed` event carries. They are written as the run recorded them: Harbor defines
  its input count as including cached tokens, which is how the OpenAI- and Google-shaped providers
  of this repository count theirs, while Anthropic's API reports cache reads beside its input
  tokens, so for that provider `n_cache_tokens` holds the difference. `cost_usd` is left unset,
  because the provider contract carries no pricing.
- `metadata` names the Agent Result outcome and failure code, any runtime limit that ended the
  session, the Model Turn and Tool Call counts, the Evaluation Profile, the SHA-256 of every
  executable in the artifact, the file that `install()` put in the container
  (`installed_executable`), and whether the log was truncated.
- `trajectory.json` is written beside the `coding-agent/` directory, at the path Harbor reads a
  trajectory from. It is the event log converted to ATIF following the table of ADR 0005 §6:
  `run.json`'s system prompt is the system step, the Coding Task and Verification feedback are
  user steps, each completed Assistant Message is an agent step with its Tool Calls and their
  results, each Model Turn's usage is that step's metrics, and the Agent Result is
  `final_metrics`, whose `extra` also names the outcome, the failure or cancellation, and
  whether the log was truncated. A Tool Call with no Tool Result, and a failed or cancelled
  message, record their outcome in `extra` rather than being dropped. ATIF's displayable
  reasoning is always absent: an Assistant Message carries text and Tool Calls only, and no
  provider of this repository produces reasoning content. The document is validated with Harbor's
  `Trajectory` model before it is written, and follows the ATIF version that model defaults to.

Three modules do this. `run_log.py` reads and checks the three files, and marks a log that does
not end with `session_settled` as truncated. `trajectory.py` converts a `RunLog` into Harbor's
`Trajectory` and writes it. `trial_context.py` fills the `AgentContext` and writes the trajectory.
The conversion reads files only: it needs no network and no Harbor job.

A run whose files are missing or unreadable must not turn a finished trial into a harness
exception: Harbor runs the verifier after the agent phase, so an exception from this hook ends the
trial before the verifier runs. The agent therefore reports the problem as a warning in the job
log instead of raising. The run files are read and the trajectory is built before the context is
touched, so a log that cannot be read or converted leaves the context as it was found; only
writing `trajectory.json` can fail after the counts and the metadata are set.

## Oracle job

The oracle job is step 2 of ADR 0005 §7. It runs Harbor's built-in oracle agent on every task of
the job's dataset. The oracle agent applies the reference solution of each task. It uses no
provider key and no model. The job therefore proves the dataset pin, the Harbor pin, the locked
dependencies, and Modal access before any job puts a credential in a task container.

A task is harness-flaky when its oracle reward is below 1 or when its trial has no reward. A
harness-flaky task fails without any agent, so the harness or the task causes the failure. It stays
in the denominator of the recorded job, and the recorded job's report names it (ADR 0005 §8).

The job needs a Modal account. It pays compute for one task environment per task, and for one GPU
for each GPU task that the dataset declares. A person runs it.

### Run the job

Run these steps from the repository root, with uv 0.13.8 (see Commands).

1. Sign in to Modal. This command writes a Modal token to `~/.modal.toml`. The Modal token is not
   a provider key.

   ```sh
   uv run --project evaluation/terminalbench --frozen modal setup
   ```

2. Run the job. This example uses the default pin of ADR 0008 §2. For another dataset, use the
   identifier of its committed dataset record.

   ```sh
   uv run --project evaluation/terminalbench --frozen harbor run \
     -d terminal-bench/terminal-bench@4.1.0 \
     -a oracle -e modal -k 1 -n <concurrency> -r 0 \
     -o jobs --job-name <job name>
   ```

Do not add `--ae`, `-m`, `-i`, `-x`, `-l`, a timeout flag, or a resource override. The record
command below refuses a job that passes a variable to the agent, names a model, filters the tasks,
or changes the task conditions. `-n` changes only the wall-clock time.

Harbor writes the job directory to `jobs/<job name>`. Git ignores `jobs/`, so a job directory is
never committed by accident. Keep the directory after the job ends: the record names the job, and
the record tooling of the recorded job can read it again.

### Record the harness-flaky tasks

Run this command from the repository root after the job ends:

```sh
uv run --project evaluation/terminalbench --frozen python -m coding_agent_terminalbench.oracle_job \
  jobs/<job name> \
  --dataset terminal-bench/terminal-bench@4.1.0 \
  --source-repository https://github.com/harbor-framework/terminal-bench \
  --release-tag v4.1.0 \
  --release-commit 4070d6cef56a7d20cb5dc98d5e10ada88a6b9440 \
  --output evaluation/terminalbench/runs/<job name>/oracle.json
```

The four dataset values come from the dataset record: ADR 0008 §4 for the default pin, or
`evaluation/terminalbench/datasets/<org>/<name>@<version>.md` for any other dataset. The module
`oracle_job.py` reads the job's `config.json`, `lock.json` and `result.json`, and the `result.json`
and `lock.json` of each trial. It makes these checks:

- The job ran one agent, Harbor's built-in `oracle`, with no model, on `modal`, with one attempt
  per task and no retry.
- The job ran exactly one dataset, its name is the record's name, and no task filter, timeout
  multiplier, timeout override, resource override, or disabled verifier changed the tasks. Its
  reference is the record's version or the content hash of a version (see below).
- The Harbor version in `lock.json` is the version that `uv.lock` pins.
- The job passes no variable to the agent, and no provider key variable anywhere.
- The job finished, every trial that `lock.json` plans has a `result.json`, and every task has one
  trial.
- The release tag resolves to the record's release commit. The command runs
  `git ls-remote --tags <repository> refs/tags/<tag>` for this check, so it needs `git` and the
  network.

Harbor writes `config.json` without the fields that keep their default value. The module therefore
reads a missing field as its Harbor 0.23.0 default, for example one attempt per task.

For a package dataset (a name with `/`), Harbor replaces the version in `config.json` with the
content hash of the version that it resolved, for example `sha256:<hash>`. The command cannot map
the hash back to a version, so it accepts any content hash. The record keeps the hash as
`resolvedReference`, and the digest of each task names the content that ran.

| Exit code | Meaning |
| --- | --- |
| 0 | Every check passed. The command wrote `oracle.json` and printed the harness-flaky tasks. |
| 1 | The job breaks a check. The command lists each problem and writes nothing. |
| 2 | A file of the job cannot be read, or the release tag cannot be resolved. |

`oracle.json` holds these values. It holds no variable value.

- The job name, id, start and end times, and wall-clock time.
- The Harbor version and commit from `lock.json`, and the Modal SDK version from `uv.lock`.
- The flags, and the names of the variables that the job passes.
- The dataset identifier, the reference that Harbor resolved, the source repository, release tag,
  release commit, the command that resolved the commit, and the task count.
- Each task with its trial, digest, reward and exception type.
- The harness-flaky tasks with their rewards.

Commit `oracle.json`. Then add a comment to the Jira ticket of the job with the `harbor run`
command, the wall-clock time that the record command printed, and the compute cost that Modal
shows for the job. The later jobs use these values for planning.
