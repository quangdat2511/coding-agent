"""Reads a finished Harbor job directory and the files Coding Agent wrote (ADR 0005 §4 and §7).

record.py decides what a recorded job must look like; this module only reads the files that a
finished Harbor job directory holds, and the run.json, events.jsonl and result.json that Coding
Agent wrote for each of its trials (ADR 0005 §4):

- config.json, lock.json and result.json of the job, which Harbor 0.23.0 writes
  (harbor/models/job/config.py, lock.py and result.py);
- <trial>/result.json and <trial>/lock.json of every trial, with its timings, its verifier reward
  and its exception;
- <trial>/agent/coding-agent/run.json and result.json, the Coding Agent files that ADR 0005 §4
  makes the external contract, for the profile, the provider and model, the sampling settings and
  the Agent Result.

It reads these files as JSON, like oracle_job.py, so its tests can write a job directory by hand. It
computes the two facts that ADR 0005 §7 needs from the files: whether a trial is rerun-eligible
(including its HTTP status condition) and which phase it stopped in.
"""

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.launch import split_model
from coding_agent_terminalbench.oracle_job import (
    OracleJobError,
    config_section,
    parse_time,
    read_object,
)


# ADR 0005 §4: Coding Agent writes its three files under --output-dir, and the adapter names that
# directory coding-agent under Harbor's agent log directory. Harbor downloads the log directory to
# trial dir / agent, so a trial's run is trial/agent/coding-agent/.
AGENT_LOG_DIR = "agent"
RUN_FILES_DIR = "coding-agent"

# The four phases Harbor times per trial, in execution order (harbor/models/trial/result.py).
PHASES = ("environment_setup", "agent_setup", "agent_execution", "verifier")
PHASE_NAMES = {
    "environment_setup": "environment setup",
    "agent_setup": "agent setup",
    "agent_execution": "agent execution",
    "verifier": "the verifier",
}

# ADR 0005 §7: a MODEL_FAILURE whose details record HTTP 401, 403, 429 or 5xx is rerun-eligible.
RERUN_PROVIDER_STATUSES = frozenset({401, 403, 429, *range(500, 600)})

# Harbor writes config.json with exclude_defaults (Job.run in harbor/job.py), so a field that keeps
# its JobConfig default is absent. These are the defaults of the fields this module reads.
JOB_CONFIG_DEFAULTS: Mapping[str, Any] = {"n_attempts": 1, "n_concurrent_trials": 4}
RETRY_DEFAULT_MAX_RETRIES = 0


class RecordError(ValueError):
    """The job does not have the shape ADR 0005 §7 makes a recorded job."""


@dataclass(frozen=True)
class AgentRun:
    """The part of Coding Agent's run.json that the record reads (ADR 0005 §4)."""

    provider: str | None
    model: str | None
    sampling: Mapping[str, Any] | None
    profile: str | None
    limits: Mapping[str, Any]
    approval_policy: str | None
    version: str | None
    commit: str | None


@dataclass(frozen=True)
class AgentOutcome:
    """The Agent Result that Coding Agent's result.json records (ADR 0005 §4)."""

    outcome: str | None
    failure_code: str | None
    http_status: int | None


@dataclass(frozen=True)
class Trial:
    """One Harbor trial of a job directory."""

    name: str
    task: str
    digest: str
    reward: Mapping[str, float | int] | None
    exception_type: str | None
    phases: Mapping[str, tuple[datetime | None, datetime | None]]
    multi_step: bool
    verifier_environment_mode: str | None
    agent_context: Mapping[str, Any]
    run: AgentRun | None
    outcome: AgentOutcome | None
    rerun_reason: str | None

    @property
    def rerun_eligible(self) -> bool:
        return self.rerun_reason is not None

    @property
    def metadata(self) -> Mapping[str, Any]:
        """The metadata that the adapter recorded in the trial's Agent Context (ADR 0005 §6)."""
        return config_section(self.agent_context.get("metadata"))

    @property
    def model_turns(self) -> int | None:
        return whole_number(self.metadata.get("model_turns"))

    @property
    def tool_calls(self) -> int | None:
        return whole_number(self.metadata.get("tool_calls"))

    @property
    def input_tokens(self) -> int | None:
        return whole_number(self.agent_context.get("n_input_tokens"))

    @property
    def cache_tokens(self) -> int | None:
        return whole_number(self.agent_context.get("n_cache_tokens"))

    @property
    def output_tokens(self) -> int | None:
        return whole_number(self.agent_context.get("n_output_tokens"))

    @property
    def installed_executable(self) -> str | None:
        value = self.metadata.get("installed_executable")
        return value if isinstance(value, str) else None

    @property
    def artifact_sha256(self) -> Mapping[str, Any]:
        return config_section(self.metadata.get("artifact_sha256"))

    @property
    def duration_seconds(self) -> float | None:
        """How long the agent phase of the trial ran, from Harbor's timing of it."""
        started, finished = self.phases.get("agent_execution", (None, None))
        if started is None or finished is None:
            return None
        try:
            return (finished - started).total_seconds()
        except TypeError:
            # One time has a time zone and the other has none.
            return None


@dataclass(frozen=True)
class HarborJob:
    """The files of one finished Harbor job directory."""

    directory: str
    config: Mapping[str, Any]
    lock: Mapping[str, Any]
    result: Mapping[str, Any]
    trials: tuple[Trial, ...]
    unfinished_trials: tuple[str, ...]

    @property
    def name(self) -> str:
        return str(self.config.get("job_name"))

    @property
    def dataset(self) -> Mapping[str, Any]:
        datasets = self.config.get("datasets")
        if not isinstance(datasets, list) or len(datasets) != 1:
            return {}
        return config_section(datasets[0])

    @property
    def agents(self) -> list[Any]:
        agents = self.config.get("agents")
        return agents if isinstance(agents, list) else []

    @property
    def agent(self) -> Mapping[str, Any]:
        agents = self.agents
        return config_section(agents[0]) if len(agents) == 1 else {}

    @property
    def agent_environment(self) -> Mapping[str, Any]:
        return config_section(self.agent.get("env"))

    @property
    def agent_kwargs(self) -> Mapping[str, Any]:
        return config_section(self.agent.get("kwargs"))

    @property
    def model_name(self) -> str | None:
        value = self.agent.get("model_name")
        return value if isinstance(value, str) else None

    @property
    def n_attempts(self) -> Any:
        return self.config.get("n_attempts", JOB_CONFIG_DEFAULTS["n_attempts"])

    @property
    def n_concurrent_trials(self) -> Any:
        return self.config.get("n_concurrent_trials", JOB_CONFIG_DEFAULTS["n_concurrent_trials"])

    @property
    def max_retries(self) -> Any:
        retry = config_section(self.config.get("retry")).get("max_retries")
        if retry is None:
            retry = config_section(self.lock.get("retry")).get("max_retries")
        return RETRY_DEFAULT_MAX_RETRIES if retry is None else retry

    @property
    def harbor_version(self) -> Any:
        return config_section(self.lock.get("harbor")).get("version")

    @property
    def harbor_git_commit(self) -> Any:
        return config_section(self.lock.get("harbor")).get("git_commit_hash")

    @property
    def first_run(self) -> AgentRun | None:
        """The first trial's Coding Agent run.json, when one trial reached the agent phase."""
        for trial in self.trials:
            if trial.run is not None:
                return trial.run
        return None

    @property
    def profile_name(self) -> str | None:
        run = self.first_run
        return run.profile if run is not None else None

    @property
    def limits(self) -> Mapping[str, Any]:
        """The SessionLimits every trial ran, or an empty mapping when none did."""
        run = self.first_run
        return run.limits if run is not None else {}

    @property
    def sampling(self) -> Mapping[str, Any] | None:
        run = self.first_run
        return run.sampling if run is not None else None

    @property
    def model_choice(self) -> tuple[str | None, str | None]:
        """The provider and model, from a trial's run.json or from the -m value."""
        run = self.first_run
        if run is not None and run.provider is not None and run.model is not None:
            return run.provider, run.model
        try:
            choice = split_model(self.model_name)
        except ValueError:
            return None, None
        return choice.provider, choice.model

    @property
    def planned_trials(self) -> list[Any]:
        trials = self.lock.get("trials")
        return trials if isinstance(trials, list) else []

    def planned_tasks(self) -> tuple[tuple[str, str], ...]:
        """The (org/name, digest) of every task that lock.json plans, sorted by name.

        ADR 0005 §7 runs one attempt per task and no filter on the recorded job, so this is the
        job's resolved task list and the report's N.
        """
        tasks: list[tuple[str, str]] = []
        for trial in self.planned_trials:
            task = config_section(config_section(trial).get("task"))
            name, digest = task.get("name"), task.get("digest")
            if not isinstance(name, str) or not isinstance(digest, str):
                raise RecordError(
                    f"{self.directory}/lock.json plans a trial without a task name and digest"
                )
            tasks.append((name, digest))
        return tuple(sorted(tasks))

    def task_filter(self) -> tuple[str, ...]:
        """The task names of the -i filter, or nothing when the job has no filter."""
        tasks = self.config.get("tasks")
        if not isinstance(tasks, list):
            return ()
        names: list[str] = []
        for entry in tasks:
            name = config_section(entry).get("name")
            if not isinstance(name, str) or name == "":
                raise RecordError(f"{self.directory}/config.json has a task filter without a name")
            names.append(name)
        return tuple(names)

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
            return None


def trial_completed(trial: Trial) -> bool:
    """ADR 0005 §7: a trial is completed when it has a reward and is not rerun-eligible."""
    return trial.reward is not None and not trial.rerun_eligible


@dataclass(frozen=True)
class TaskOutcome:
    """The recorded outcome of one task of the recorded job (ADR 0005 §7)."""

    task: str
    digest: str
    original: Trial
    recorded: Trial | None

    @property
    def completed(self) -> bool:
        return self.recorded is not None and trial_completed(self.recorded)

    @property
    def from_rerun(self) -> bool:
        return self.recorded is not None and self.recorded is not self.original


@dataclass(frozen=True)
class ArchivePart:
    """One part of the published archive of the job directories (ADR 0005 §8)."""

    file: str
    bytes: int
    sha256: str


@dataclass(frozen=True)
class OracleRecord:
    """The committed record of the job's oracle job (oracle_job.py, ADR 0005 §7 step 2)."""

    job: str
    dataset: str
    content_hash: str | None
    harness_flaky: tuple[Mapping[str, Any], ...]


def provider_env_template(name: str) -> str:
    """The template that Harbor stores for an --ae value, as ADR 0005 §7 passes it."""
    return "$" + "{" + name + "}"


def whole_number(value: Any) -> int | None:
    """A whole, non-negative count, or None when the value is absent or malformed."""
    return value if type(value) is int and value >= 0 else None


def read_rewards(rewards: Any, source: str) -> Mapping[str, float | int] | None:
    """A trial's verifier rewards, read as Harbor's mean reads one trial's reward dict."""
    if rewards is None:
        return None
    if not isinstance(rewards, dict):
        raise RecordError(f"{source}: verifier_result.rewards must be an object")
    if len(rewards) == 0:
        return None
    values: dict[str, float | int] = {}
    for key, value in rewards.items():
        if not isinstance(key, str) or key == "":
            raise RecordError(f"{source}: a reward key must be a non-empty string")
        # bool is an int in Python, and NaN is not a reward that can be compared or written.
        if (
            isinstance(value, bool)
            or not isinstance(value, int | float)
            or not math.isfinite(value)
        ):
            raise RecordError(
                f"{source}: the reward {key!r} must be a finite number, "
                f"found {json.dumps(value)}"
            )
        values[key] = value
    return values


def interrupted_phase(
    phases: Mapping[str, tuple[datetime | None, datetime | None]],
    occurred_at: datetime | None = None,
) -> str | None:
    """The phase a trial was in when it stopped, from Harbor's phase timings (ADR 0005 §8).

    Harbor finishes a phase's timing in a finally block (harbor/trial/trial.py), so a phase that
    failed has both times. The exception's occurred_at falls inside the failed phase's window, and
    that is the phase the trial stopped in. The timings of the phases that never ran are absent.

    When the trial result carries no occurred_at, the last phase that started is the best evidence:
    Harbor starts no later phase after a failure, except the verifier, which runs after an agent
    failure or timeout.
    """
    if occurred_at is not None:
        for name in PHASES:
            started, finished = phases[name]
            if started is None:
                continue
            try:
                if finished is not None and started <= occurred_at <= finished:
                    return name
                if finished is None and started <= occurred_at:
                    return name
            except TypeError:
                # One time has a time zone and the other has none; the fallback below is all this
                # result can support.
                break
    started_phases = [name for name in PHASES if phases[name][0] is not None]
    return started_phases[-1] if started_phases else None


def rerun_reason(
    reward: Mapping[str, float | int] | None,
    outcome: AgentOutcome | None,
    exception_type: str | None,
    interrupted: str | None,
) -> str | None:
    """Why ADR 0005 §7 reruns a trial, or None when the trial is not rerun-eligible."""
    if reward is None:
        detail = f" ({exception_type})" if exception_type else ""
        if interrupted is not None:
            detail += f" during {PHASE_NAMES[interrupted]}"
        return f"no verifier reward{detail}"
    if (
        outcome is not None
        and outcome.outcome == "failed"
        and outcome.failure_code == "MODEL_FAILURE"
        and outcome.http_status in RERUN_PROVIDER_STATUSES
    ):
        return f"MODEL_FAILURE with the provider's HTTP {outcome.http_status}"
    return None


def read_agent_run(run_dir: Path) -> AgentRun | None:
    """Reads Coding Agent's run.json from a trial's agent log directory, when it wrote one."""
    path = run_dir / "run.json"
    if not path.exists():
        return None
    data = read_object(path)
    coding_agent = config_section(data.get("codingAgent"))
    sampling = data.get("sampling")
    return AgentRun(
        provider=optional_text(data, "provider"),
        model=optional_text(data, "model"),
        sampling=dict(sampling) if isinstance(sampling, Mapping) else None,
        profile=optional_text(data, "profile"),
        limits=config_section(data.get("limits")),
        approval_policy=optional_text(data, "approvalPolicy"),
        version=optional_text(coding_agent, "version"),
        commit=optional_text(coding_agent, "commit"),
    )


def read_agent_outcome(run_dir: Path) -> AgentOutcome | None:
    """Reads Coding Agent's result.json from a trial's agent log directory, when it wrote one.

    It holds the Agent Result and the failure details. ADR 0005 §7's rerun rule reads the HTTP
    status from there (CDA-83), and a trial that failed before the agent ran has no file.
    """
    path = run_dir / "result.json"
    if not path.exists():
        return None
    data = read_object(path)
    result = config_section(data.get("result"))
    failure = config_section(result.get("failure"))
    details = config_section(failure.get("details"))
    http_status = details.get("httpStatus")
    return AgentOutcome(
        outcome=optional_text(result, "outcome"),
        failure_code=optional_text(failure, "code"),
        http_status=http_status if type(http_status) is int else None,
    )


def optional_text(data: Mapping[str, Any], key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) else None


def read_trial(trial_dir: Path) -> Trial:
    """Reads one trial directory: its result.json and lock.json, and Coding Agent's run files."""
    result_path = trial_dir / "result.json"
    result = read_object(result_path)
    lock_path = trial_dir / "lock.json"
    lock = read_object(lock_path) if lock_path.exists() else {}
    task = config_section(lock.get("task"))
    task_name = task.get("name")
    if not isinstance(task_name, str) or task_name == "":
        task_name = result.get("task_name")
    digest = task.get("digest")
    if not isinstance(task_name, str) or task_name == "":
        raise RecordError(f"{result_path}: the trial does not name its task")
    if not isinstance(digest, str) or digest == "":
        raise RecordError(f"{trial_dir}/lock.json has no task digest")

    phases = {
        name: (
            parse_time(config_section(result.get(name)).get("started_at")),
            parse_time(config_section(result.get(name)).get("finished_at")),
        )
        for name in PHASES
    }
    exception_info = config_section(result.get("exception_info"))
    exception_type = exception_info.get("exception_type")
    verifier_result = config_section(result.get("verifier_result"))
    reward = read_rewards(verifier_result.get("rewards"), str(result_path))
    run_dir = trial_dir / AGENT_LOG_DIR / RUN_FILES_DIR
    run = read_agent_run(run_dir)
    outcome = read_agent_outcome(run_dir)
    interrupted = interrupted_phase(
        phases, parse_time(exception_info.get("occurred_at"))
    )
    step_results = result.get("step_results")
    return Trial(
        name=str(result.get("trial_name", trial_dir.name)),
        task=task_name,
        digest=digest,
        reward=reward,
        exception_type=exception_type if isinstance(exception_type, str) else None,
        phases=phases,
        multi_step=isinstance(step_results, list) and len(step_results) > 0,
        verifier_environment_mode=optional_text(result, "verifier_environment_mode"),
        agent_context=config_section(result.get("agent_result")),
        run=run,
        outcome=outcome,
        rerun_reason=rerun_reason(
            reward,
            outcome,
            exception_type if isinstance(exception_type, str) else None,
            interrupted,
        ),
    )


def read_job(job_dir: Path) -> HarborJob:
    """Reads a Harbor job directory that the harbor run command finished."""
    if not job_dir.is_dir():
        raise OracleJobError(f"{job_dir} is not a directory; give the Harbor job directory")
    config = read_object(job_dir / "config.json")
    lock = read_object(job_dir / "lock.json")
    result = read_object(job_dir / "result.json")
    trials: list[Trial] = []
    unfinished: list[str] = []
    for entry in sorted(job_dir.iterdir()):
        # Harbor keeps hidden directories such as .sources beside the trial directories.
        if not entry.is_dir() or entry.name.startswith("."):
            continue
        if (entry / "result.json").exists():
            trials.append(read_trial(entry))
        else:
            unfinished.append(entry.name)
    return HarborJob(
        directory=str(job_dir),
        config=config,
        lock=lock,
        result=result,
        trials=tuple(sorted(trials, key=lambda trial: (trial.task, trial.name))),
        unfinished_trials=tuple(unfinished),
    )


def read_oracle_record(path: Path) -> OracleRecord:
    """Reads the oracle.json that oracle_job.py wrote for the same dataset (ADR 0005 §7 step 2)."""
    data = read_object(path)
    schema_version = data.get("schemaVersion")
    if type(schema_version) is not int or schema_version != 1:
        raise OracleJobError(f"{path}: schemaVersion must be 1, found {json.dumps(schema_version)}")
    job = config_section(data.get("job"))
    dataset = config_section(data.get("dataset"))
    name = job.get("name")
    identifier = dataset.get("identifier")
    if not isinstance(name, str) or name == "":
        raise OracleJobError(f"{path}: the oracle record has no job name")
    if not isinstance(identifier, str) or identifier == "":
        raise OracleJobError(f"{path}: the oracle record has no dataset identifier")
    flaky = data.get("harnessFlakyTasks")
    if not isinstance(flaky, list):
        raise OracleJobError(f"{path}: harnessFlakyTasks must be an array")
    entries: list[Mapping[str, Any]] = []
    for entry in flaky:
        if not isinstance(entry, Mapping):
            raise OracleJobError(f"{path}: every harnessFlakyTasks entry must be an object")
        entries.append(entry)
    content_hash = dataset.get("contentHash")
    return OracleRecord(
        job=name,
        dataset=identifier,
        content_hash=content_hash if isinstance(content_hash, str) else None,
        harness_flaky=tuple(entries),
    )


def hash_archive_parts(paths: Sequence[Path]) -> tuple[ArchivePart, ...]:
    """The SHA-256 of every archive part, as ADR 0005 §8 records them."""
    parts: list[ArchivePart] = []
    for path in paths:
        try:
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b""):
                    size += len(chunk)
                    digest.update(chunk)
        except FileNotFoundError:
            raise RecordError(f"{path} does not exist; give the archive parts to hash") from None
        except OSError as exc:
            raise RecordError(f"cannot read {path}: {exc}") from exc
        parts.append(ArchivePart(file=path.name, bytes=size, sha256=digest.hexdigest()))
    return tuple(parts)
