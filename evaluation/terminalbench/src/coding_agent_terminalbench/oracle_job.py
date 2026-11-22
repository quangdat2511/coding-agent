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

It reads these files as JSON, like `manifest.py`, so its tests can write a job directory by hand.
It imports Harbor only in `resolve_registry_dataset`, which asks Harbor's package registry what a
dataset version holds. The dataset record (ADR 0008 §1 and §4) is given on the command line,
because no rule here may assume a dataset name, version or task count.
"""

import argparse
import asyncio
import json
import math
import os
import subprocess
import sys
import tempfile
import tomllib
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.launch import KEY_VARIABLES

RECORD_SCHEMA_VERSION = 1

ORACLE_AGENT = "oracle"
ORACLE_ENVIRONMENT = "modal"

DEFAULT_UV_LOCK = Path("evaluation/terminalbench/uv.lock")
DEFAULT_JOBS_DIR = "jobs"

# Harbor writes config.json with `exclude_defaults=True` (`Job.run` in harbor/job.py), so a field
# that keeps its `JobConfig` default is absent. These are the defaults of the fields recorded here.
JOB_CONFIG_DEFAULTS: Mapping[str, Any] = {"n_attempts": 1, "n_concurrent_trials": 4}
RETRY_DEFAULT_MAX_RETRIES = 0

# The fields that `harbor run -d <dataset> -a oracle -e modal -k 1 -n <n> -r 0 -o <dir>
# --job-name <name>` writes to config.json, and the fields of their sections. A test builds the
# config with Harbor's own CLI to keep this list true. Every other field changes the job away from
# the oracle job of ADR 0005 §7 step 2 (another verifier, an override, a filter, a retry), so the
# check refuses it instead of naming the fields that it knows to be harmful.
ALLOWED_JOB_FIELDS = frozenset(
    {"job_name", "jobs_dir", "n_concurrent_trials", "agents", "environment", "datasets"}
)
ALLOWED_AGENT_FIELDS = frozenset({"name"})
ALLOWED_ENVIRONMENT_FIELDS = frozenset({"type"})
ALLOWED_DATASET_FIELDS = frozenset({"name", "ref"})

# The flag that restores a refused field, for the fields that a flag of the command sets.
FIELD_HINTS: Mapping[str, str] = {"n_attempts": "run with -k 1", "retry": "run with -r 0"}

# How the record's content hash and task list were resolved.
REGISTRY_LOOKUP = "Harbor's package registry, the lookup that `harbor run -d` makes"


class OracleJobError(ValueError):
    """A file of the job is missing or unreadable, or a record cannot be resolved or written."""


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
class RegistryDataset:
    """What Harbor's package registry holds for the record's dataset version."""

    content_hash: str
    # (`org/name`, digest) of each task, sorted.
    tasks: tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class Evidence:
    """What the job is checked against: its records, and what they resolve to now."""

    dataset: DatasetRecord
    pins: LockedPins
    release_commit: str
    registry: RegistryDataset
    # Why the record names the release commit without resolving its tag, or None.
    release_tag_waiver: str | None = None


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

    def field_or_default(self, field: str) -> Any:
        """A config.json field, or its `JobConfig` default when Harbor left it out."""
        return self.config.get(field, JOB_CONFIG_DEFAULTS.get(field))

    @property
    def dataset(self) -> Mapping[str, Any]:
        """The one dataset in config.json, or an empty mapping when there is not exactly one."""
        datasets = self.config.get("datasets")
        if not isinstance(datasets, list) or len(datasets) != 1:
            return {}
        return config_section(datasets[0])

    @property
    def dataset_reference(self) -> Any:
        """The ref of the package dataset, as Harbor left it in config.json.

        `Job.create` replaces the ref of `-d org/name@version` with the content hash of the
        dataset version that the registry resolves (`DatasetConfig._get_package_task_configs`)
        before it writes config.json, so the ref is `sha256:<content hash>`.
        """
        return self.dataset.get("ref")

    @property
    def harbor_version(self) -> str | None:
        return config_section(self.lock.get("harbor")).get("version")

    @property
    def harbor_git_commit(self) -> str | None:
        return config_section(self.lock.get("harbor")).get("git_commit_hash")

    @property
    def planned_trials(self) -> list[Any]:
        trials = self.lock.get("trials")
        return trials if isinstance(trials, list) else []

    def planned_tasks(self) -> Counter[tuple[Any, Any]]:
        """(`org/name`, digest) of the task of each trial that lock.json plans."""
        tasks = (config_section(config_section(trial).get("task")) for trial in self.planned_trials)
        return Counter((task.get("name"), task.get("digest")) for task in tasks)

    def started_at(self) -> datetime | None:
        return parse_time(self.result.get("started_at"))

    def finished_at(self) -> datetime | None:
        return parse_time(self.result.get("finished_at"))

    def wall_clock_seconds(self) -> float | None:
        started, finished = self.started_at(), self.finished_at()
        if started is None or finished is None:
            return None
        try:
            return (finished - started).total_seconds()
        except TypeError:
            # One time has a time zone and the other has none.
            return None


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def config_section(value: Any) -> Mapping[str, Any]:
    """A JSON object of the job files, or an empty mapping when the value is not one."""
    return value if isinstance(value, dict) else {}


def variable_names(value: Any) -> Iterator[str]:
    """The name of every variable that an `env` object anywhere in the config passes.

    `config_problems` refuses every `env` field already. This scan also reads sections that the
    check refuses as a whole, such as `user_agent`, so the message names a provider key wherever
    it is.
    """
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "env" and isinstance(child, dict):
                yield from (str(name) for name in child)
            else:
                yield from variable_names(child)
    elif isinstance(value, list):
        for child in value:
            yield from variable_names(child)


def read_json(path: Path) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise OracleJobError(f"{path} does not exist") from None
    except (OSError, UnicodeDecodeError) as exc:
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
    # NaN is not below 1, and json.dumps would write it as `NaN`, which is not JSON.
    if isinstance(reward, bool) or not isinstance(reward, int | float) or not math.isfinite(reward):
        raise OracleJobError(
            f"{source}: the reward must be a finite number, found {json.dumps(reward)}"
        )
    return reward


def read_trial(trial_dir: Path) -> TaskOutcome:
    result_path = trial_dir / "result.json"
    result = read_object(result_path)
    task_name = result.get("task_name")
    if not isinstance(task_name, str) or task_name == "":
        raise OracleJobError(f"{result_path}: task_name must be a non-empty string")
    verifier_result = config_section(result.get("verifier_result"))
    exception_type = config_section(result.get("exception_info")).get("exception_type")
    # Harbor writes the trial's lock.json when it creates the trial, before the trial runs. Its
    # task names the content that ran, by the same `org/name` and digest as the job's lock.json.
    name, digest = task_name, None
    lock_path = trial_dir / "lock.json"
    if lock_path.exists():
        task = config_section(read_object(lock_path).get("task"))
        if isinstance(task.get("name"), str):
            name = task["name"]
        if isinstance(task.get("digest"), str):
            digest = task["digest"]
    return TaskOutcome(
        name=name,
        trial_name=str(result.get("trial_name", trial_dir.name)),
        digest=digest,
        reward=read_reward(verifier_result.get("rewards"), result_path),
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
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
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
DatasetResolver = Callable[[str], RegistryDataset]


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
        raise OracleJobError(f"{command} exited {completed.returncode}: {completed.stderr.strip()}")
    return completed.stdout


def ls_remote_args(repository: str, tag: str) -> list[str]:
    ref = f"refs/tags/{tag}"
    return ["ls-remote", "--tags", repository, ref, f"{ref}^{{}}"]


def resolve_release_commit(repository: str, tag: str, run: Runner = run_git) -> str:
    """Resolves the dataset's release tag in its source repository (ADR 0008 §1).

    An annotated tag points at a tag object. `git ls-remote` then also lists the peeled ref
    `refs/tags/<tag>^{}`, which names the commit, so that line wins.
    """
    ref = f"refs/tags/{tag}"
    output = run(ls_remote_args(repository, tag))
    found: dict[str, str] = {}
    for line in output.splitlines():
        sha, _, name = line.partition("\t")
        if name in (ref, f"{ref}^{{}}"):
            found[name] = sha.strip()
    commit = found.get(f"{ref}^{{}}") or found.get(ref)
    if commit is None:
        raise OracleJobError(f"{repository} has no tag {tag}")
    return commit


def resolve_registry_dataset(identifier: str) -> RegistryDataset:
    """Asks Harbor's package registry what `org/name@version` holds.

    This is the lookup that `harbor run -d` makes before the job starts. A public dataset needs no
    Harbor login. The registry can still differ from what the job ran if a maintainer moves the
    version's tag, and the check then reports the difference.
    """
    from harbor.models.task.id import PackageTaskId
    from harbor.registry.client.package import PackageDatasetClient

    try:
        metadata = asyncio.run(PackageDatasetClient().get_dataset_metadata(identifier))
    except Exception as exc:  # The network, the registry service, or an unknown version.
        raise OracleJobError(f"Harbor's registry cannot resolve {identifier}: {exc}") from exc
    tasks = tuple(
        sorted(
            (task.get_name(), str(task.ref))
            for task in metadata.task_ids
            if isinstance(task, PackageTaskId)
        )
    )
    return RegistryDataset(content_hash=str(metadata.version), tasks=tasks)


def unexpected_fields(
    section_name: str, value: Mapping[str, Any], allowed: frozenset[str]
) -> list[str]:
    problems = []
    for field in sorted(set(value) - allowed):
        path = f"{section_name}.{field}" if section_name else field
        hint = FIELD_HINTS.get(path, "remove it")
        problems.append(
            f"config.json sets `{path}`, which the oracle command leaves at its default ({hint})"
        )
    return problems


def config_problems(job: OracleJob) -> list[str]:
    """Compares config.json with the config that the oracle command of the README writes."""
    config = job.config
    problems = unexpected_fields("", config, ALLOWED_JOB_FIELDS)

    # Harbor leaves `agents` out when it is `[AgentConfig()]`, which is the oracle agent.
    agents = config.get("agents", [{}])
    if not isinstance(agents, list) or len(agents) != 1 or not isinstance(agents[0], dict):
        problems.append(f"the job must run exactly one agent, Harbor's built-in `{ORACLE_AGENT}`")
    else:
        agent = agents[0]
        problems.extend(unexpected_fields("agents[0]", agent, ALLOWED_AGENT_FIELDS))
        # `AgentConfig.set_default_name`: an agent with no name and no import path is the oracle.
        if agent.get("name", ORACLE_AGENT) != ORACLE_AGENT:
            problems.append(
                f"the job must run Harbor's built-in `{ORACLE_AGENT}` agent, "
                f"found {json.dumps(agent.get('name'))}"
            )

    environment = config_section(config.get("environment"))
    problems.extend(unexpected_fields("environment", environment, ALLOWED_ENVIRONMENT_FIELDS))
    if environment.get("type") != ORACLE_ENVIRONMENT:
        problems.append(
            f"the job must run on `{ORACLE_ENVIRONMENT}` (-e {ORACLE_ENVIRONMENT}), "
            f"found {json.dumps(environment.get('type'))}"
        )

    datasets = config.get("datasets")
    if not isinstance(datasets, list) or len(datasets) != 1:
        problems.append("the job must run exactly one dataset (one -d)")
    else:
        problems.extend(unexpected_fields("datasets[0]", job.dataset, ALLOWED_DATASET_FIELDS))
    return problems


def dataset_problems(job: OracleJob, evidence: Evidence) -> list[str]:
    dataset = evidence.dataset
    problems = []
    name = dataset.identifier.rpartition("@")[0]
    if job.dataset and job.dataset.get("name") != name:
        problems.append(
            f"the job ran dataset {json.dumps(job.dataset.get('name'))}, but the dataset record "
            f"is {dataset.identifier}"
        )
    elif job.dataset and job.dataset_reference != evidence.registry.content_hash:
        problems.append(
            f"the job ran dataset content {json.dumps(job.dataset_reference)}, but Harbor's "
            f"registry resolves {dataset.identifier} to {evidence.registry.content_hash}"
        )
    planned = job.planned_tasks()
    registry = Counter(evidence.registry.tasks)
    if planned != registry:
        problems.append(
            f"lock.json plans {sum(planned.values())} tasks, and "
            f"{sum((planned - registry).values())} of them are not in {dataset.identifier}; "
            f"the registry lists {len(evidence.registry.tasks)} tasks, and "
            f"{sum((registry - planned).values())} of them are not planned"
        )
    if evidence.release_commit != dataset.release_commit:
        problems.append(
            f"tag {dataset.release_tag} of {dataset.source_repository} resolves to "
            f"{evidence.release_commit}, but the dataset record names {dataset.release_commit}"
        )
    return problems


def pin_problems(job: OracleJob, evidence: Evidence) -> list[str]:
    if job.harbor_version == evidence.pins.harbor:
        return []
    return [
        f"the job ran Harbor {job.harbor_version}, but uv.lock pins {evidence.pins.harbor}; run it "
        "through `uv run --project evaluation/terminalbench --frozen`"
    ]


def variable_problems(job: OracleJob) -> list[str]:
    keys = sorted(set(variable_names(job.config)) & KEY_VARIABLES)
    if not keys:
        return []
    return [f"the job passes the provider credential variable {', '.join(keys)}"]


def result_problems(job: OracleJob) -> list[str]:
    result = job.result
    problems = []
    if not isinstance(result.get("id"), str) or result.get("id") == "":
        problems.append("result.json has no job id")
    if job.started_at() is None:
        problems.append("result.json has no started_at time that can be read")
    if result.get("finished_at") is None:
        problems.append("the job did not finish: result.json has no finished_at")
    elif job.finished_at() is None:
        problems.append("result.json has a finished_at time that cannot be read")
    if job.started_at() is not None and job.finished_at() is not None:
        seconds = job.wall_clock_seconds()
        if seconds is None:
            problems.append("started_at and finished_at in result.json must both have a time zone")
        elif seconds < 0:
            problems.append("result.json has a finished_at time before its started_at time")
    return problems


def trial_problems(job: OracleJob) -> list[str]:
    problems = [
        f"trial {trial} did not finish: it has no result.json" for trial in job.unfinished_trials
    ]
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
    problems.extend(
        f"trial {task.trial_name} has no task digest in its lock.json"
        for task in job.tasks
        if task.digest is None
    )
    ran = Counter((task.name, task.digest) for task in job.tasks if task.digest is not None)
    if ran - job.planned_tasks():
        problems.append("the trials ran tasks that lock.json does not plan")
    return problems


def check_oracle_job(job: OracleJob, evidence: Evidence) -> list[str]:
    """Returns every way the job breaks ADR 0005 §7 step 2 or differs from its records."""
    return [
        *config_problems(job),
        *dataset_problems(job, evidence),
        *pin_problems(job, evidence),
        *variable_problems(job),
        *result_problems(job),
        *trial_problems(job),
    ]


def harbor_run_command(job: OracleJob, evidence: Evidence) -> str:
    """The command that writes the job's config.json, which `config_problems` makes sure of."""
    return (
        f"harbor run -d {evidence.dataset.identifier} -a {ORACLE_AGENT} -e {ORACLE_ENVIRONMENT} "
        f"-k 1 -n {job.field_or_default('n_concurrent_trials')} -r 0 "
        f"-o {job.config.get('jobs_dir', DEFAULT_JOBS_DIR)} --job-name {job.name}"
    )


def oracle_record(job: OracleJob, evidence: Evidence) -> dict[str, Any]:
    """The committed record of the oracle job. It holds no variable's value, only names."""
    dataset = evidence.dataset
    return {
        "schemaVersion": RECORD_SCHEMA_VERSION,
        "job": {
            "name": job.name,
            "id": job.result.get("id"),
            "startedAt": job.result.get("started_at"),
            "finishedAt": job.result.get("finished_at"),
            "wallClockSeconds": job.wall_clock_seconds(),
        },
        "command": harbor_run_command(job, evidence),
        "harbor": {"version": job.harbor_version, "gitCommitHash": job.harbor_git_commit},
        "modalSdk": {"version": evidence.pins.modal, "source": "uv.lock"},
        "flags": {
            "agent": ORACLE_AGENT,
            "environment": config_section(job.config.get("environment")).get("type"),
            "nAttempts": job.field_or_default("n_attempts"),
            "nConcurrentTrials": job.field_or_default("n_concurrent_trials"),
            "maxRetries": RETRY_DEFAULT_MAX_RETRIES,
        },
        "environmentVariableNames": sorted(set(variable_names(job.config))),
        "dataset": {
            "identifier": dataset.identifier,
            "contentHash": job.dataset_reference,
            "contentHashResolvedBy": REGISTRY_LOOKUP,
            "sourceRepository": dataset.source_repository,
            "releaseTag": dataset.release_tag,
            "releaseCommit": evidence.release_commit,
            "releaseCommitResolvedBy": (
                f"recorded: {evidence.release_tag_waiver}"
                if evidence.release_tag_waiver is not None
                else "git "
                + " ".join(ls_remote_args(dataset.source_repository, dataset.release_tag))
            ),
            "taskCount": len(job.planned_trials),
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
        f"Command: {record['command']}",
    ]
    for task in flaky:
        reward = "no reward" if task["reward"] is None else f"reward {task['reward']}"
        exception = f", {task['exceptionType']}" if task["exceptionType"] else ""
        lines.append(f"  {task['name']}: {reward}{exception}")
    return "\n".join(lines)


def write_record(path: Path, record: Mapping[str, Any]) -> None:
    """Writes the record through a temporary file, so a failed write leaves no partial record."""
    text = json.dumps(record, indent=2, allow_nan=False) + "\n"
    temporary: str | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as file:
            temporary = file.name
            file.write(text)
        os.replace(temporary, path)
    except OSError as exc:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
        raise OracleJobError(f"cannot write {path}: {exc}") from exc


def main(
    argv: Sequence[str] | None = None,
    *,
    run: Runner = run_git,
    resolve_dataset: DatasetResolver = resolve_registry_dataset,
) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m coding_agent_terminalbench.oracle_job",
        description=(
            "Check a finished oracle job (ADR 0005 §7 step 2) and record its harness-flaky tasks."
        ),
    )
    parser.add_argument("job_dir", type=Path, help="the Harbor job directory")
    parser.add_argument("--dataset", required=True, help="the record's org/name@version")
    parser.add_argument("--source-repository", required=True, help="the record's source repository")
    parser.add_argument("--release-tag", required=True, help="the record's release tag")
    parser.add_argument("--release-commit", required=True, help="the record's release commit")
    parser.add_argument("--output", type=Path, required=True, help="the oracle.json file to write")
    parser.add_argument(
        "--waive-release-tag",
        metavar="REASON",
        help=(
            "record the release commit the dataset record names without resolving its tag, "
            "stating why; for a source repository that publishes no tag"
        ),
    )
    parser.add_argument("--uv-lock", type=Path, default=DEFAULT_UV_LOCK, help="the uv.lock file")
    args = parser.parse_args(argv)
    name, _, version = args.dataset.rpartition("@")
    if "/" not in name or version == "":
        # Harbor resolves `org/name@version` through its package registry; ADR 0008 §1 requires
        # an explicit version.
        parser.error("--dataset must be a package dataset with a version, org/name@version")

    dataset = DatasetRecord(
        identifier=args.dataset,
        source_repository=args.source_repository,
        release_tag=args.release_tag,
        release_commit=args.release_commit,
    )
    try:
        pins = read_locked_pins(args.uv_lock)
        job = read_oracle_job(args.job_dir)
        evidence = Evidence(
            dataset=dataset,
            pins=pins,
            release_commit=(
                dataset.release_commit
                if args.waive_release_tag is not None
                else resolve_release_commit(
                    dataset.source_repository, dataset.release_tag, run
                )
            ),
            registry=resolve_dataset(dataset.identifier),
            release_tag_waiver=args.waive_release_tag,
        )
    except OracleJobError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    problems = check_oracle_job(job, evidence)
    if problems:
        print(
            "The oracle job does not meet ADR 0005 §7 step 2. Nothing is written.", file=sys.stderr
        )
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    record = oracle_record(job, evidence)
    try:
        write_record(args.output, record)
    except OracleJobError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(summary(record))
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
