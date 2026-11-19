"""Checks a finished oracle job and records its harness-flaky tasks (ADR 0005 §7, step 2).

The oracle job runs Harbor's built-in oracle agent, which needs no provider key and no model. It
proves the job's dataset pin, the Harbor pin, the locked dependencies and Modal access. A task whose
oracle reward is below 1 is harness-flaky: it stays in the denominator of the recorded job, and the
recorded job's report names it.

This module reads the files that Harbor 0.23.0 writes into a job directory:

- `config.json`: the `JobConfig` (`harbor/models/job/config.py`).
- `lock.json`: the `JobLock`, with the Harbor version and one `TrialLock` per planned trial
  (`harbor/models/job/lock.py`).
- `result.json`: the `JobResult`, with the start and end times (`harbor/models/job/result.py`).
- `<trial>/result.json` and `<trial>/lock.json`: the `TrialResult` and `TrialLock` of each trial
  (`harbor/models/trial/result.py`).

It imports nothing from Harbor, like `manifest.py`, so its tests need no Harbor job. The dataset
record (ADR 0008 §1 and §4) is given on the command line, because no rule here may assume a
dataset name, version or task count.
"""

import argparse
import json
import subprocess
import sys
import tomllib
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.launch import KEY_VARIABLES

RECORD_SCHEMA_VERSION = 1

ORACLE_AGENT = "oracle"
ORACLE_ENVIRONMENT = "modal"

DEFAULT_UV_LOCK = Path("evaluation/terminalbench/uv.lock")

# The prefix of the content hash that Harbor writes as a package dataset's resolved ref.
CONTENT_HASH_PREFIX = "sha256:"

# Harbor writes config.json with `exclude_defaults=True` (`Job.run` in harbor/job.py), so a field
# that keeps its `JobConfig` default is absent. These are the defaults of the fields read here.
JOB_CONFIG_DEFAULTS: Mapping[str, Any] = {
    "n_attempts": 1,
    "n_concurrent_trials": 4,
    "timeout_multiplier": 1.0,
}
RETRY_DEFAULT_MAX_RETRIES = 0

# Fields that change a task's resources or timeouts. The oracle job runs every task under its own
# conditions, so a reward below 1 means the harness, not an override, failed the task.
AGENT_OVERRIDE_FIELDS = ("override_timeout_sec", "override_setup_timeout_sec", "max_timeout_sec")
ENVIRONMENT_OVERRIDE_FIELDS = (
    "override_cpus",
    "override_memory_mb",
    "override_storage_mb",
    "override_gpus",
    "override_tpu",
)
VERIFIER_OVERRIDE_FIELDS = ("override_timeout_sec", "max_timeout_sec")


class OracleJobError(ValueError):
    """A file of the job directory is missing, unreadable, or does not have Harbor's shape."""


@dataclass(frozen=True)
class DatasetRecord:
    """The values of the job dataset's record: ADR 0008 §4, or its committed dataset file."""

    identifier: str
    source_repository: str
    release_tag: str
    release_commit: str


@dataclass(frozen=True)
class LockedPins:
    """The versions that `uv.lock` resolves, which `uv run --frozen` installs (ADR 0005 §1)."""

    harbor: str
    modal: str


@dataclass(frozen=True)
class TaskOutcome:
    """The one trial of a task in the oracle job."""

    name: str
    trial_name: str
    digest: str | None
    reward: float | int | None
    exception_type: str | None

    @property
    def harness_flaky(self) -> bool:
        # A trial without a reward counts as 0, as Harbor's `mean` counts it.
        return self.reward is None or self.reward < 1


@dataclass(frozen=True)
class OracleJob:
    """The parts of a Harbor job directory that the oracle record uses."""

    config: Mapping[str, Any]
    lock: Mapping[str, Any]
    result: Mapping[str, Any]
    tasks: tuple[TaskOutcome, ...]
    # Trial directories that have no result.json: the trial did not finish.
    unfinished_trials: tuple[str, ...]

    @property
    def name(self) -> str:
        return str(self.config.get("job_name"))

    def setting(self, field: str) -> Any:
        """A config.json field, or its `JobConfig` default when Harbor left it out."""
        return self.config.get(field, JOB_CONFIG_DEFAULTS.get(field))

    @property
    def agents(self) -> list[dict[str, Any]]:
        """The job's agents. Harbor leaves the field out when it is `[AgentConfig()]`."""
        agents = self.config.get("agents", [{}])
        if not isinstance(agents, list):
            return []
        return [agent if isinstance(agent, dict) else {"name": agent} for agent in agents]

    @staticmethod
    def agent_name(agent: Mapping[str, Any]) -> Any:
        """The agent's name, or None for an agent that Harbor imports from a path."""
        if agent.get("import_path") is not None:
            return None
        # `AgentConfig.set_default_name`: an agent with no name and no import path is the oracle.
        return agent.get("name") or ORACLE_AGENT

    @property
    def max_retries(self) -> Any:
        retry = self.config.get("retry")
        if not isinstance(retry, dict):
            return RETRY_DEFAULT_MAX_RETRIES
        return retry.get("max_retries", RETRY_DEFAULT_MAX_RETRIES)

    @property
    def harbor_version(self) -> str | None:
        harbor = self.lock.get("harbor")
        return harbor.get("version") if isinstance(harbor, dict) else None

    @property
    def harbor_git_commit(self) -> str | None:
        harbor = self.lock.get("harbor")
        return harbor.get("git_commit_hash") if isinstance(harbor, dict) else None

    @property
    def planned_trials(self) -> list[Any]:
        trials = self.lock.get("trials")
        return trials if isinstance(trials, list) else []

    @property
    def dataset(self) -> Mapping[str, Any]:
        """The one dataset in config.json, or an empty mapping when there is not exactly one."""
        datasets = self.config.get("datasets")
        if not isinstance(datasets, list) or len(datasets) != 1:
            return {}
        return datasets[0] if isinstance(datasets[0], dict) else {}

    @property
    def dataset_reference(self) -> Any:
        """The version reference of the dataset, as Harbor left it in config.json.

        A registry dataset keeps `-d name@version` in `version`. A package dataset (`org/name`)
        keeps it in `ref`, and `Job.create` replaces that ref with the content hash of the
        resolved dataset version (`DatasetConfig._get_package_task_configs`) before it writes
        config.json, so a package dataset's ref is `sha256:<content hash>`.
        """
        return self.dataset.get("ref") or self.dataset.get("version")

    @property
    def dataset_identifier(self) -> str:
        """`name@reference` of the dataset in config.json, for messages."""
        return f"{self.dataset.get('name')}@{self.dataset_reference}"

    def wall_clock_seconds(self) -> float | None:
        started = parse_time(self.result.get("started_at"))
        finished = parse_time(self.result.get("finished_at"))
        if started is None or finished is None:
            return None
        return (finished - started).total_seconds()

    def environment_variable_names(self) -> dict[str, list[str]]:
        """The names, never the values, of the variables that the job passes, by section."""
        names: dict[str, list[str]] = {"agent": [], "environment": [], "verifier": []}
        for agent in self.agents:
            names["agent"].extend(env_names(agent))
        names["environment"].extend(env_names(self.config.get("environment")))
        names["verifier"].extend(env_names(self.config.get("verifier")))
        return {where: sorted(set(found)) for where, found in names.items()}


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def section(config: Mapping[str, Any], field: str) -> Mapping[str, Any]:
    value = config.get(field)
    return value if isinstance(value, dict) else {}


def is_content_hash(reference: Any) -> bool:
    return isinstance(reference, str) and reference.startswith(CONTENT_HASH_PREFIX)


def env_names(part: Any) -> list[str]:
    if not isinstance(part, dict):
        return []
    env = part.get("env")
    return [str(name) for name in env] if isinstance(env, dict) else []


def read_json(path: Path) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise OracleJobError(f"{path} does not exist") from None
    except OSError as exc:
        raise OracleJobError(f"cannot read {path}: {exc}") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise OracleJobError(f"{path} is not valid JSON: {exc}") from exc


def read_object(path: Path) -> dict[str, Any]:
    data = read_json(path)
    if not isinstance(data, dict):
        raise OracleJobError(f"{path} must hold a JSON object")
    return data


def read_reward(rewards: Any, source: Path) -> float | int | None:
    """The trial's reward, read as Harbor's `mean` reads a single-key reward dict."""
    if rewards is None:
        return None
    if not isinstance(rewards, dict):
        raise OracleJobError(f"{source}: verifier_result.rewards must be an object")
    if len(rewards) == 0:
        return None
    if len(rewards) > 1:
        # Harbor's mean then reports one mean per key, and "reward below 1" has no single meaning.
        raise OracleJobError(
            f"{source}: verifier_result.rewards has several keys ({', '.join(sorted(rewards))}); "
            "this record reads a single reward"
        )
    reward = next(iter(rewards.values()))
    if isinstance(reward, bool) or not isinstance(reward, int | float):
        raise OracleJobError(f"{source}: the reward must be a number, found {json.dumps(reward)}")
    return reward


def read_trial(trial_dir: Path) -> TaskOutcome:
    result_path = trial_dir / "result.json"
    result = read_object(result_path)
    task_name = result.get("task_name")
    if not isinstance(task_name, str) or task_name == "":
        raise OracleJobError(f"{result_path}: task_name must be a non-empty string")
    verifier_result = result.get("verifier_result")
    rewards = verifier_result.get("rewards") if isinstance(verifier_result, dict) else None
    exception_info = result.get("exception_info")
    exception_type = (
        exception_info.get("exception_type") if isinstance(exception_info, dict) else None
    )
    # Harbor writes the trial's lock.json when the trial starts. The digest names the task content
    # that ran, so the record identifies it even when two pins share task names.
    digest = None
    lock_path = trial_dir / "lock.json"
    if lock_path.exists():
        task = read_object(lock_path).get("task")
        if isinstance(task, dict) and isinstance(task.get("digest"), str):
            digest = task["digest"]
    return TaskOutcome(
        name=task_name,
        trial_name=str(result.get("trial_name", trial_dir.name)),
        digest=digest,
        reward=read_reward(rewards, result_path),
        exception_type=exception_type if isinstance(exception_type, str) else None,
    )


def read_oracle_job(job_dir: Path) -> OracleJob:
    """Reads the job directory that `harbor run -o <jobs dir> --job-name <name>` wrote."""
    if not job_dir.is_dir():
        raise OracleJobError(f"{job_dir} is not a directory; give the Harbor job directory")
    config = read_object(job_dir / "config.json")
    lock = read_object(job_dir / "lock.json")
    result = read_object(job_dir / "result.json")
    tasks: list[TaskOutcome] = []
    unfinished: list[str] = []
    for entry in sorted(job_dir.iterdir()):
        # Harbor keeps hidden directories such as `.sources` beside the trial directories.
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if (entry / "result.json").exists():
            tasks.append(read_trial(entry))
        else:
            unfinished.append(entry.name)
    return OracleJob(
        config=config,
        lock=lock,
        result=result,
        tasks=tuple(sorted(tasks, key=lambda task: task.name)),
        unfinished_trials=tuple(unfinished),
    )


def read_locked_pins(uv_lock: Path) -> LockedPins:
    try:
        with uv_lock.open("rb") as file:
            lock = tomllib.load(file)
    except FileNotFoundError:
        raise OracleJobError(
            f"{uv_lock} does not exist; run the command from the repository root"
        ) from None
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise OracleJobError(f"cannot read {uv_lock}: {exc}") from exc
    packages = {
        package.get("name"): package.get("version")
        for package in lock.get("package", [])
        if isinstance(package, dict)
    }
    missing = [name for name in ("harbor", "modal") if not isinstance(packages.get(name), str)]
    if missing:
        raise OracleJobError(f"{uv_lock} resolves no version of {', '.join(missing)}")
    return LockedPins(harbor=packages["harbor"], modal=packages["modal"])


Runner = Callable[[Sequence[str]], str]


def run_git(args: Sequence[str]) -> str:
    command = f"git {' '.join(args)}"
    try:
        completed = subprocess.run(
            ["git", *args], capture_output=True, text=True, check=False, timeout=60
        )
    except subprocess.TimeoutExpired:
        raise OracleJobError(f"{command} did not answer in 60 s") from None
    except OSError as exc:
        # FileNotFoundError when git is not on PATH.
        raise OracleJobError(f"cannot run {command}: {exc}") from exc
    if completed.returncode != 0:
        raise OracleJobError(
            f"{command} exited {completed.returncode}: {completed.stderr.strip()}"
        )
    return completed.stdout


def resolve_release_commit(repository: str, tag: str, run: Runner = run_git) -> str:
    """Resolves the dataset's release tag in its source repository (ADR 0008 §1).

    An annotated tag points at a tag object. `git ls-remote` then also lists the peeled ref
    `refs/tags/<tag>^{}`, which names the commit, so that line wins.
    """
    ref = f"refs/tags/{tag}"
    output = run(["ls-remote", "--tags", repository, ref, f"{ref}^{{}}"])
    found: dict[str, str] = {}
    for line in output.splitlines():
        sha, _, name = line.partition("\t")
        if name in (ref, f"{ref}^{{}}"):
            found[name] = sha.strip()
    commit = found.get(f"{ref}^{{}}") or found.get(ref)
    if commit is None:
        raise OracleJobError(f"{repository} has no tag {tag}")
    return commit


def check_oracle_job(
    job: OracleJob, *, dataset: DatasetRecord, pins: LockedPins, release_commit: str
) -> list[str]:
    """Returns every way the job breaks ADR 0005 §7 step 2 or differs from its records."""
    problems: list[str] = []
    config = job.config

    agents = job.agents
    if len(agents) != 1 or job.agent_name(agents[0]) != ORACLE_AGENT:
        problems.append(f"the job must run exactly one agent, Harbor's built-in `{ORACLE_AGENT}`")
    else:
        agent = agents[0]
        if agent.get("model_name") is not None:
            problems.append("the oracle agent takes no model, but the job names one with -m")
        problems.extend(
            f"the job must not change the task conditions (agent {field} is set)"
            for field in AGENT_OVERRIDE_FIELDS
            if agent.get(field) is not None
        )

    environment = section(config, "environment")
    environment_type = environment.get("type")
    if environment_type != ORACLE_ENVIRONMENT:
        problems.append(
            f"the job must run on `{ORACLE_ENVIRONMENT}` (-e {ORACLE_ENVIRONMENT}), "
            f"found {json.dumps(environment_type)}"
        )
    problems.extend(
        f"the job must not change the task conditions (environment {field} is set)"
        for field in ENVIRONMENT_OVERRIDE_FIELDS
        if environment.get(field) is not None
    )
    verifier = section(config, "verifier")
    if verifier.get("disable"):
        problems.append(
            "the job must run the verifier, which gives the reward (verifier disable is set)"
        )
    problems.extend(
        f"the job must not change the task conditions (verifier {field} is set)"
        for field in VERIFIER_OVERRIDE_FIELDS
        if verifier.get(field) is not None
    )

    n_attempts = job.setting("n_attempts")
    if n_attempts != 1:
        problems.append(f"the job must make one attempt per task (-k 1), found {n_attempts}")
    max_retries = job.max_retries
    if max_retries != 0:
        # Harbor deletes a trial's directory before it retries the trial, so a retry hides the
        # failure that makes the task harness-flaky.
        problems.append(f"the job must not retry trials (-r 0), found max_retries {max_retries}")
    if job.setting("timeout_multiplier") != 1.0:
        problems.append("the job must not change the task timeouts (timeout_multiplier is not 1)")
    for field in (
        "agent_timeout_multiplier",
        "verifier_timeout_multiplier",
        "agent_setup_timeout_multiplier",
        "environment_build_timeout_multiplier",
    ):
        if config.get(field) not in (None, 1.0):
            problems.append(f"the job must not change the task timeouts ({field} is set)")

    datasets = config.get("datasets")
    if not isinstance(datasets, list) or len(datasets) != 1 or config.get("tasks"):
        problems.append("the job must run exactly one dataset (one -d) and no separate task")
    else:
        record_name, _, record_version = dataset.identifier.rpartition("@")
        reference = job.dataset_reference
        # A content hash is what Harbor resolved the record's version to; this command cannot
        # map it back to the version, so it accepts it and the record keeps it.
        if job.dataset.get("name") != record_name or not (
            reference == record_version or is_content_hash(reference)
        ):
            problems.append(
                f"the job ran dataset {job.dataset_identifier}, but the dataset record is "
                f"{dataset.identifier}"
            )
        for field in ("task_names", "exclude_task_names", "n_tasks"):
            if job.dataset.get(field):
                problems.append(f"the job must run every task of the dataset ({field} is set)")

    if release_commit != dataset.release_commit:
        problems.append(
            f"tag {dataset.release_tag} of {dataset.source_repository} resolves to "
            f"{release_commit}, but the dataset record names {dataset.release_commit}"
        )

    if job.harbor_version != pins.harbor:
        problems.append(
            f"the job ran Harbor {job.harbor_version}, but uv.lock pins {pins.harbor}; run it "
            "through `uv run --project evaluation/terminalbench --frozen`"
        )

    names = job.environment_variable_names()
    if names["agent"]:
        problems.append(
            "the oracle agent needs no environment variable, but the job passes "
            + ", ".join(names["agent"])
        )
    keys = sorted({name for found in names.values() for name in found} & KEY_VARIABLES)
    if keys:
        problems.append(f"the job passes the provider credential variable {', '.join(keys)}")

    if job.result.get("finished_at") is None:
        problems.append("the job did not finish: result.json has no finished_at")
    for trial in job.unfinished_trials:
        problems.append(f"trial {trial} did not finish: it has no result.json")
    planned = len(job.planned_trials)
    if planned == 0:
        problems.append("lock.json plans no trial")
    if job.result.get("n_total_trials") != planned:
        problems.append(
            f"result.json counts {job.result.get('n_total_trials')} trials, "
            f"lock.json plans {planned}"
        )
    if len(job.tasks) != planned:
        problems.append(
            f"the job directory has {len(job.tasks)} finished trials, lock.json plans {planned}"
        )
    counts = Counter(task.name for task in job.tasks)
    repeated = sorted(name for name, count in counts.items() if count > 1)
    if repeated:
        problems.append(f"these tasks have more than one trial: {', '.join(repeated)}")
    planned_digests = Counter(
        section(trial, "task").get("digest")
        for trial in job.planned_trials
        if isinstance(trial, dict)
    )
    # A trial that failed before Harbor wrote its lock.json has no digest to compare. Every other
    # digest must be planned; with the trial count checked above, this makes the two sets equal.
    trial_digests = Counter(task.digest for task in job.tasks if task.digest is not None)
    if trial_digests - planned_digests:
        problems.append("the task digests of the trials differ from the ones that lock.json plans")
    return problems


def oracle_record(
    job: OracleJob, *, dataset: DatasetRecord, pins: LockedPins, release_commit: str
) -> dict[str, Any]:
    """The committed record of the oracle job. It holds no variable's value, only names."""
    environment = job.config.get("environment")
    return {
        "schemaVersion": RECORD_SCHEMA_VERSION,
        "job": {
            "name": job.name,
            "id": job.result.get("id"),
            "startedAt": job.result.get("started_at"),
            "finishedAt": job.result.get("finished_at"),
            "wallClockSeconds": job.wall_clock_seconds(),
        },
        "harbor": {"version": job.harbor_version, "gitCommitHash": job.harbor_git_commit},
        "modalSdk": {"version": pins.modal, "source": "uv.lock"},
        "flags": {
            "agent": ORACLE_AGENT,
            "environment": environment.get("type") if isinstance(environment, dict) else None,
            "nAttempts": job.setting("n_attempts"),
            "nConcurrentTrials": job.setting("n_concurrent_trials"),
            "maxRetries": job.max_retries,
        },
        "environmentVariableNames": job.environment_variable_names(),
        "dataset": {
            "identifier": dataset.identifier,
            "resolvedReference": job.dataset_reference,
            "sourceRepository": dataset.source_repository,
            "releaseTag": dataset.release_tag,
            "releaseCommit": release_commit,
            "releaseCommitResolvedBy": (
                f"git ls-remote --tags {dataset.source_repository} refs/tags/{dataset.release_tag}"
            ),
            "taskCount": len(job.tasks),
        },
        "tasks": [
            {
                "name": task.name,
                "trial": task.trial_name,
                "digest": task.digest,
                "reward": task.reward,
                "exceptionType": task.exception_type,
            }
            for task in job.tasks
        ],
        "harnessFlakyTasks": [
            {"name": task.name, "reward": task.reward, "exceptionType": task.exception_type}
            for task in job.tasks
            if task.harness_flaky
        ],
    }


def summary(record: Mapping[str, Any]) -> str:
    """A plain text summary for the person who ran the job."""
    job = record["job"]
    dataset = record["dataset"]
    flaky = record["harnessFlakyTasks"]
    lines = [
        f"Oracle job {job['name']} on {dataset['identifier']} ({dataset['releaseCommit']})",
        f"Harbor {record['harbor']['version']}, Modal SDK {record['modalSdk']['version']}",
        f"Tasks: {dataset['taskCount']}, harness-flaky: {len(flaky)}",
        f"Wall clock: {job['wallClockSeconds']} s",
    ]
    for task in flaky:
        reward = "no reward" if task["reward"] is None else f"reward {task['reward']}"
        exception = f", {task['exceptionType']}" if task["exceptionType"] else ""
        lines.append(f"  {task['name']}: {reward}{exception}")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None, *, run: Runner = run_git) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m coding_agent_terminalbench.oracle_job",
        description=(
            "Check a finished oracle job (ADR 0005 §7 step 2) and record its harness-flaky tasks."
        ),
    )
    parser.add_argument("job_dir", type=Path, help="the Harbor job directory")
    parser.add_argument("--dataset", required=True, help="the record's name@version")
    parser.add_argument("--source-repository", required=True, help="the record's source repository")
    parser.add_argument("--release-tag", required=True, help="the record's release tag")
    parser.add_argument("--release-commit", required=True, help="the record's release commit")
    parser.add_argument("--output", type=Path, required=True, help="the oracle.json file to write")
    parser.add_argument("--uv-lock", type=Path, default=DEFAULT_UV_LOCK, help="the uv.lock file")
    args = parser.parse_args(argv)

    dataset = DatasetRecord(
        identifier=args.dataset,
        source_repository=args.source_repository,
        release_tag=args.release_tag,
        release_commit=args.release_commit,
    )
    try:
        pins = read_locked_pins(args.uv_lock)
        job = read_oracle_job(args.job_dir)
        release_commit = resolve_release_commit(dataset.source_repository, dataset.release_tag, run)
    except OracleJobError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    problems = check_oracle_job(job, dataset=dataset, pins=pins, release_commit=release_commit)
    if problems:
        print(
            "The oracle job does not meet ADR 0005 §7 step 2. Nothing is written.", file=sys.stderr
        )
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    record = oracle_record(job, dataset=dataset, pins=pins, release_commit=release_commit)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(summary(record))
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
