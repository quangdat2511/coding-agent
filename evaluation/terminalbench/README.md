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

`tests/test_oracle_job.py` writes its own job directories, because only that module reads them.
It writes most of them by hand and some with Harbor's own models (see Oracle job).
`tests/test_record.py` and `tests/test_secret_scan.py` write their own too: a synthetic recorded
job, its smoke job and its rerun job, and the files of the secret scan. `tests/test_dataset_record.py`
reads ADR 0008 §4 for the default pin and writes a small record for another dataset.

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

Do not add any other flag. The record command refuses a job whose `config.json` differs from the
one that this command writes, so a variable, a model, a task filter, a timeout, a resource
override, another verifier, or a retry makes the job unusable. `-n` changes only the wall-clock
time.

Harbor writes the job directory to `jobs/<job name>`. Git ignores `jobs/`, so a job directory is
never committed by accident. Keep the directory after the job ends: the record names the job, and
the record tooling of the recorded job can read it again.

### Record the harness-flaky tasks

Run this command from the repository root after the job ends:

```sh
uv run --project evaluation/terminalbench --frozen python -m coding_agent_terminalbench.oracle_job   jobs/<job name>   --dataset terminal-bench/terminal-bench@4.1.0   --source-repository https://github.com/harbor-framework/terminal-bench   --release-tag v4.1.0   --release-commit 4070d6cef56a7d20cb5dc98d5e10ada88a6b9440   --output evaluation/terminalbench/runs/<job name>/oracle.json
```

The four dataset values come from the dataset record: ADR 0008 §4 for the default pin, or
`evaluation/terminalbench/datasets/<org>/<name>@<version>.md` for any other dataset. The dataset
must be a package dataset with a version, `org/name@version`. The module `oracle_job.py` reads the
job's `config.json`, `lock.json` and `result.json`, and the `result.json` and `lock.json` of each
trial. It makes these checks:

- `config.json` sets only the fields that the `harbor run` command above sets: the job name, the
  jobs directory, the concurrency, the `oracle` agent, the `modal` environment, and one dataset
  with its name and ref. The check refuses every other field, and names it.
- The dataset name is the record's name. The ref is the content hash that Harbor's package
  registry resolves the record's version to. The tasks that `lock.json` plans, by name and digest,
  are the tasks that the registry lists for that version.
- The Harbor version in `lock.json` is the version that `uv.lock` pins.
- No `env` field anywhere in `config.json` names a provider key variable.
- `result.json` has the job id, and start and end times with a time zone, in order.
- Every trial directory has a `result.json` and a `lock.json`. The trials ran exactly the tasks
  that `lock.json` plans, one trial per task.
- The release tag resolves to the record's release commit.

Two checks need the network. The command runs
`git ls-remote --tags <repository> refs/tags/<tag> refs/tags/<tag>^{}`, so it needs `git`. It asks
Harbor's package registry what the dataset version holds, which is the lookup that `harbor run -d`
makes and needs no Harbor login for a public dataset.

Harbor writes `config.json` without the fields that keep their default value. A missing field
therefore has its Harbor 0.23.0 default, for example one attempt per task. Harbor also replaces
the version of a package dataset in `config.json` with the content hash of that version, for
example `sha256:<hash>`. A test builds the config with Harbor's own CLI and checks it against both
rules.

The checks cover the Harbor version and the dataset of ADR 0005 §1. The record takes the Modal SDK
version from `uv.lock`, because `uv run --frozen` installs it. The checks do not cover the Python
version or the Harbor commit: Harbor from PyPI has no commit, and `lock.json` records it as null.

| Exit code | Meaning |
| --- | --- |
| 0 | Every check passed. The command wrote `oracle.json` and printed the harness-flaky tasks. |
| 1 | The job breaks a check. The command lists each problem and writes nothing. |
| 2 | A file cannot be read or written, a release tag or a dataset version cannot be resolved, or an argument is wrong. |

The command writes `oracle.json` through a temporary file, so a failed write leaves no partial
record. `oracle.json` holds these values. It holds no variable value.

- `schemaVersion`, which is 1.
- The job name, id, start and end times, and wall-clock time.
- `command`: the `harbor run` command that writes the job's `config.json`. The check makes sure
  that the job ran this command.
- The Harbor version and commit from `lock.json`, and the Modal SDK version from `uv.lock`.
- The flags, and the names of the variables that the job passes, which is an empty list.
- The dataset identifier, its content hash, the source repository, release tag, release commit,
  how the hash and the commit were resolved, and the number of planned tasks.
- Each task with its trial, digest, reward and exception type.
- The harness-flaky tasks with their rewards.

Commit `oracle.json`. Then add a comment to the Jira ticket of the job with the `harbor run`
command and the wall-clock time that the record command printed, and the compute cost that Modal
shows for the job. The later jobs use these values for planning.

## Credential isolation test

ADR 0005 §7 allows no smoke, recorded or rerun job to start until an automated test shows that no
Tool Call can get the provider key from the artifact (ADR 0001 §8). This command is that test. It
runs the artifact in the container of one task of the job's dataset, as the user that Harbor runs
the agent as, and has Tool Calls try the four paths of ADR 0005 §7 item 2: the inherited
environment, `/proc/<pid>/environ` of the Coding Agent process, its `/proc/<pid>/mem`, and every
ancestor. It also checks that a launcher which does not `exec` the agent is refused by the startup
check. It uses a disposable key that it makes for each run, so it never reads the environment of the
host and never sends a real key to a container.

It needs `uv`, a running Docker daemon, and a build of the artifact (`bun run build:artifact`). Run
it from the repository root. The dataset and the task are required and have no default, because
no test fixes a dataset (ADR 0008 §5). The command below names the default pin and one of its smoke
tasks only as an example:

```sh
uv run --project evaluation/terminalbench --frozen python -m \
  coding_agent_terminalbench.isolation_test \
  --dataset terminal-bench/terminal-bench@4.1.0 --task music-harmony \
  --artifact-dir dist/artifact --output isolation-result.json
```

`--dataset` is `<org>/<name>@<version>`. The command refuses `latest`, a name without a version and
a local path, as a job does (ADR 0008 §1). There is no `--user`: the agent user comes from the
task, so a task whose agent runs as root and one whose agent runs as another user are two runs of
this command with two tasks. The result records the user. `--model` is any model that the
artifact's `anthropic` catalog holds; it only has to be one that the artifact accepts.

### How it works

The compiled artifact has no test hook, so the test cannot give it a model. The `anthropic`
provider sets no base URL, so the SDK reads `ANTHROPIC_BASE_URL`, and the test points the artifact
at a fake Anthropic Messages server on the host. The server answers the first request with one
`bash` Tool Call that runs a probe, and the second with a text answer. It runs on the host, outside
the container, so no process in the container holds the key that arrives in its `x-api-key` header.
The test depends on this variable. If the artifact stops honouring it, the server gets no request,
the result has `TOOL_RESULTS_MISSING` with a message that names the variable, and the test exits 2,
because it could not drive the agent and so shows nothing about a leak.

The probe is POSIX `sh` and coreutils, uploaded as a file, so the key is in no Tool Call. Only the
probe's own short-lived `grep` processes hold it in their command line, and the probe reads the
command lines of its ancestors only. It needs GNU `dd` for the memory path, which glibc images have,
and it prints one JSON line per path with the outcome and whether it found the key, never the key.
The test reads these lines from the Tool Results that the server received, not from `events.jsonl`,
because the agent replaces the key with `[redacted]` in its files and a leak would not show there.

Each path has a control. The test runs the same probe against a process that holds the key and is
not hardened, as a child of it, in the same container as the same user. The probe must find the key
there. A probe that finds nothing on a process that holds the key proves nothing, so the test fails.

### Result

The command prints one JSON on standard output, with the keys of the artifact manifest in camelCase.
A person can attach it to the manifest. It holds the artifact's version, commit and SHA-256, the
dataset, the task, the backend, the user, the value of Yama's `ptrace_scope`, each probe and
control, and the launcher check. It holds no timestamp, so equal runs give equal results. A summary
line goes to standard error. `--output` writes the same JSON to a file.

| Exit code | Meaning |
| --- | --- |
| 0 | The test ran and the artifact passed. |
| 1 | The test ran and the artifact failed: a Tool Call found the key, or the launcher that keeps its shell was not refused. `failures` says why. |
| 2 | The test showed nothing about the artifact. Either it could not run (a wrong argument, no Docker, a container that does not build or cannot reach the server, an artifact that does not install), or every failure is one that shows nothing about a leak: `MEM_NOT_DEMONSTRABLE`, `CONTROL_FAILED` and `PATH_NOT_TESTED` come from the host or image, and `TOOL_RESULTS_MISSING` and `KEY_NOT_DELIVERED` mean that the test could not drive the agent, which can come from the artifact, for example one that ignores `ANTHROPIC_BASE_URL`. In the second case the JSON is still printed, and the summary line starts with `INCONCLUSIVE`. |

| `failures[].code` | The test fails because |
| --- | --- |
| `KEY_FOUND` | A Tool Call found the key on a path. |
| `CONTROL_FAILED` | The probe did not find the key on a process that holds it. |
| `PATH_NOT_TESTED` | A path has no probe result, or the probe could not find the agent or finish the walk. |
| `MEM_NOT_DEMONSTRABLE` | Yama denies `/proc/<pid>/mem` of an ancestor whatever its dumpability, so a denied read shows nothing about the artifact. The compiled artifact cannot lift this. |
| `LAUNCHER_NOT_REJECTED` | The launcher that keeps its shell was not refused with exit 2, the message that names the ancestor and the variable, and no request to the server. Exit 2 alone is not enough, because every configuration error exits with 2. |
| `TOOL_RESULTS_MISSING` | The server got fewer Tool Results than the script has. |
| `KEY_NOT_DELIVERED` | A request did not carry the disposable key in `x-api-key`. |

### Limits

- It runs on Docker. Harbor's Docker environment sends standard error into standard output, so the
  test reads the refusal from both. A run on Modal is the next ticket: Modal cannot reach a server
  on the host, so it needs another route to the server. The code takes any object with `exec` and
  `upload_file`, which is Harbor's `BaseEnvironment`.
- The container reaches the host as `host.docker.internal`, which Docker Desktop provides. On a
  Linux host that name does not resolve unless the container is given it. This has not been run
  there. `--container-host` and `--server-host` set the name that the container uses and the
  address that the server binds. Before the agent runs, the container opens one connection to
  the server. If it cannot, the test stops with exit 2 and says so, because a server that gets no
  Tool Result would otherwise look like an artifact that ignores `ANTHROPIC_BASE_URL`.
- If `ptrace_scope` is 1 or more, the result has `MEM_NOT_DEMONSTRABLE` and the test exits 2.
  Docker Desktop's kernel does not load Yama, so the test can pass there.
- It installs nothing in the task container. A container without `bash`, `sha256sum` or GNU `dd`
  fails the test or stops it.

### Tests

The unit tests run with the rest of the adapter's tests and need no Docker. The tests of the probe
run `sh` against `/proc`, so they run only on Linux and are skipped elsewhere. To run them on
another host, use a Linux container:

```sh
cd evaluation/terminalbench
docker run --rm -v "$PWD":/work:ro -w /work -e PYTHONPATH=src:. -e PYTHONDONTWRITEBYTECODE=1 \
  python:3.12-slim python -m unittest tests.test_isolation_probe
```

## Record tooling

The record tooling is ADR 0005 §8. A recorded job leaves a Harbor job directory under `jobs/`,
which Git ignores, and the record tooling turns the finished job into the two committed files of
`evaluation/terminalbench/runs/<job name>/`:

- `manifest.json` records the ADR 0005 §1 pins, the Coding Agent artifact, the `terminalbench` profile
  values, the provider, model and sampling settings, every Harbor flag, the names but never the
  values of the variables passed, the job times, the oracle, smoke and rerun job names, the dataset
  record of ADR 0008 with the evidence for the dataset properties, the secret scan's patterns, file
  count and result, and the SHA-256 of every archive part.
- `report.md` records validity, the dataset pin, the mean reward over the job's `N` recorded
  outcomes, the reward distribution, the per-task table, the cross-tabulation of Agent Result
  outcome against reward, every rerun-eligible trial with its reason and its rerun's outcome, the
  harness-flaky tasks and the tasks whose declared MCP servers or skills directory the adapter
  ignores. It has no Pi column and no pass or fail threshold.

`record.py` computes both files from the job directories, so no number in the report is
transcribed. It also checks the job: it refuses a job whose `config.json` is not the recorded-job
command of ADR 0005 §7, and it writes nothing when it refuses, like `oracle_job.py`.

Five modules do this. `harbor_job.py` reads the files that Harbor and Coding Agent write;
`record.py` checks the jobs against ADR 0005 §7, computes the recorded outcomes, the validity and
the mean, and writes `manifest.json`; `report.py` renders `report.md`; `dataset_record.py` reads the
committed dataset record of ADR 0008; and `secret_scan.py` is the scan of ADR 0005 §8. The tests
write small synthetic Harbor job directories, because the record can then test a shape that
Harbor's own models refuse, including one job with a planted credential and one with a missing
reward.

### The dataset record

The dataset is a job parameter, not a pin of the protocol (ADR 0008 §1), so the tooling reads the
dataset's own data from the dataset's committed record rather than from a constant:

- ADR 0008 §4 for the default pin, `terminal-bench/terminal-bench@4.1.0`.
- `evaluation/terminalbench/datasets/<org>/<name>@<version>.md` for another admissible dataset,
  committed before the first job that names it (ADR 0008 §1).

A record is Markdown with a two-column table. The tooling needs the rows that ADR 0008 §4 shows:
`Dataset identifier`, `Source repository`, `Release tag`, `Release commit`, `Smoke tasks`,
`Environment`, `Single step`, `Verifier environment` and `Per-task agent timeout`. It reads
the optional `Tasks with declared MCP servers` and `Tasks with a declared skills directory` rows
when they are present, and it reads the `Smoke tasks` and task-list rows as Markdown code spans, or
as `none`. A missing identity row is an error. A missing evidence row does not stop the tooling: it
makes the job invalid under ADR 0005 §7, and the report says which property the record cannot show,
because ADR 0005 §8 records the evidence rather than assuming it. No dataset name, version or task
count is hardcoded in the tooling, its tests or its report.

### Secret scan

ADR 0005 §8 makes the scan mandatory before the archive is published, and it is also a command of
its own, so a person can review the matches before the record is generated:

```sh
uv run --project evaluation/terminalbench --frozen python -m coding_agent_terminalbench.secret_scan \
  jobs/<job name> jobs/<job name>-rerun \
  --credential OPENCODE_API_KEY \
  --review jobs/<job name>-scan-review.json \
  --json jobs/<job name>-scan.json
```

It searches every file under each root, binary files included, for:

- the exact value of every named credential variable, read from the environment and never given on
  the command line, in UTF-8, UTF-16-LE and UTF-16-BE, because a log or a binary can encode it in
  any of them;
- `[REDACTED]`, Harbor's replacement for a value that it scrubbed;
- the provider key prefixes `sk-ant-`, `sk-or-`, `sk-proj-`, `xai-`, `AIza` and
  `oc_sk_`, which a truncated key still carries.

Each match is printed with its file and byte offset, so it can be reviewed:

```text
jobs/recorded-job/alpha__x/agent/coding-agent/events.jsonl:4127: key-prefix sk-ant- (unexplained)
```

A credential match can never be explained: the key reached the logs, so the archive is not published
and the credential is revoked, whether or not it would have been published (ADR 0005 §8 steps 1 and
4). A `[REDACTED]` or key-prefix match is explained by a review file, because a person has to show
that it is not a credential or that the file is removed:

```json
{
  "reviewed": [
    {
      "file": "jobs/<job name>/<trial>/agent/coding-agent/events.jsonl",
      "offset": 4127,
      "reason": "the task's own example text, not a credential"
    }
  ]
}
```

The file and offset are the two that the scan printed, and the reason must be non-empty. A review
entry that names a credential match, and a review entry that names no match, are problems; a stale
review cannot quietly explain nothing. The command exits 0 when every match is explained or none was
found, 1 while an unexplained match or a review problem remains, and 2 when the command line, a
credential variable, a root, a file or the review file cannot be used. It never prints or stores a
credential value.

`record.py` runs the same scan over the recorded and rerun job directories before it writes
anything, taking the credential variable names from the jobs' `--ae` flags. It does not scan the
archive parts: the scan covers the uncompressed directories that they pack, and it uses the same
review file as the command above (`--scan-review`).

### Run the record command

Run this from the repository root after the recorded job, the smoke job and any rerun job finished.
The archive parts are created before the record is written, because the manifest holds their
SHA-256 values (CDA-97 attaches them to the GitHub Release):

```sh
uv run --project evaluation/terminalbench --frozen python -m coding_agent_terminalbench.record \
  jobs/<recorded job> \
  --rerun-job jobs/<recorded job>-rerun \
  --smoke-job jobs/<smoke job> \
  --oracle-record evaluation/terminalbench/runs/<recorded job>/oracle.json \
  --dataset-record docs/adr/0008-evaluation-dataset-as-a-job-parameter.md \
  --artifact-dir dist/artifact \
  --archive-part jobs/<recorded job>.tar.zst.part-aa \
  --scan-review jobs/<recorded job>-scan-review.json \
  --output-dir evaluation/terminalbench/runs/<recorded job>
```

`--rerun-job` is omitted when no trial was rerun-eligible. Repeat `--archive-part` for every part;
each part must be under the 2 GiB that GitHub allows a release asset, and there may be at most 1,000
parts (ADR 0005 §8). `--credential NAME` adds a variable to the scan when the job passed one that
the record cannot derive from its configuration. Commit `manifest.json` and `report.md` under the
job's directory; CDA-97 publishes the archive parts and commits that record for the MVP's job.

The command refuses, and writes nothing, when:

- `config.json` is not the recorded-job command of ADR 0005 §7: another agent or import path,
  another model, more or fewer than one dataset, an environment other than `modal` for the recorded
  and rerun jobs, `-k` other than 1, `-r` other than 0, a task filter on the recorded job, a
  timeout override, another agent kwarg, or a credential that is not the template
  `NAME='${NAME}'` of the `-m` provider;
- the recorded job did not finish, did not run every task that its `lock.json` plans, ran a task
  more than once, or ran a task at another digest than its `lock.json` records;
- the trials did not run the artifact that `artifact-manifest.json` describes, by version, commit
  and every SHA-256 value, or they did not all use one profile, provider, model, sampling setting
  and `SessionLimits`;
- the smoke job did not run the smoke set that the dataset record names, or the rerun job is not
  named `<job name>-rerun` or does not repeat the recorded job's dataset, agent, model and
  artifact;
- the oracle record describes another dataset pin, or names a harness-flaky task that the job did
  not run;
- the dataset record's release tag does not resolve to the commit it names, or its smoke set and
  its declared MCP-server and skills tasks are not in the job's resolved task list;
- there is no archive part, two parts share a file name, any part is 2 GiB or larger, or there
  are more than 1,000 parts;
- the secret scan does not pass.

A job that passes those checks can still be **invalid** under ADR 0005 §7: a task may lack a
completed trial in the recorded job or the rerun job, the dataset record may lack the evidence for
one of its properties, or a trial's shape may contradict a recorded property. The command writes
the record then, because ADR 0005 §8 archives and reports an invalid job too; the report states the
invalidity, publishes no headline reward, and still shows the mean it computed for diagnosis, with a
trial without a reward counting as 0 as Harbor's mean counts it.

| Exit code | Meaning |
| --- | --- |
| 0 | Every check passed. The command wrote `manifest.json` and `report.md` into `--output-dir`. |
| 1 | A job breaks a check, or the secret scan did not pass. The command lists each problem and writes nothing. |
| 2 | A file cannot be read or written, the release tag cannot be resolved, or an argument is wrong. The command writes nothing. |

The command writes both files through temporary files, so a failed write leaves no partial record.

