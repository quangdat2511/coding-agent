"""Turns a finished Harbor job directory into the committed record (ADR 0005 §8).

A recorded TerminalBench job leaves a Harbor job directory. This module reads it, together with the
jobs ADR 0005 §7 runs around it (the oracle job, the smoke job of the same dataset and the rerun
job, when there is one), and writes the two files of ADR 0005 §8:

- manifest.json: the pins, the artifact, the profile, the provider and model, the flags, the
  dataset record of ADR 0008, the job times, the related job names, the secret scan's result and the
  archive part hashes. It holds no credential value, only the names of the variables passed.
- report.md: validity, the dataset pin, the mean reward over the job's N recorded outcomes computed
  as Harbor's mean computes it, the distribution, the per-task table, the cross-tabulation of Agent
  Result outcome against reward, the rerun-eligible trials, the harness-flaky tasks and the tasks
  whose declared MCP servers or skills directory the adapter ignores.

The dataset is a job parameter (ADR 0008), so the dataset's own data comes from its committed
record: ADR 0008 §4 for the default pin, or
evaluation/terminalbench/datasets/<org>/<name>@<version>.md for another admissible dataset. No rule
here assumes a dataset name, version or task count.

The record command is a check as well as a writer: it refuses a job whose config.json is not the
recorded-job command of ADR 0005 §7 (another agent, model, dataset, environment, filter, timeout,
retry, or a literal credential), whose trials did not run the planned tasks, whose artifact is not
the one the build hashed, or whose rerun job or smoke job does not belong to the recorded job. It
writes nothing when it refuses, like oracle_job.py.

Three options record a job that ADR 0005 §7 would refuse, each naming the waived requirement and
the reason: `--waive-isolation` for a backend the Isolation Record does not clear,
`--waive-release-tag` for a dataset repository that publishes no tag, and
`--waive-timeout-override` for a job that raised the task timeouts. The manifest and the report
carry every waiver, and the report states that such a record does not count under §9 criterion 5.
They are for a rehearsal, not for the MVP's recorded job.

harbor_job.py reads Harbor 0.23.0's job files and Coding Agent's run files as JSON, like
oracle_job.py, and report.py renders report.md from the data computed here. Its tests write a job
directory by hand.
"""

import argparse
import json
import math
import os
import platform
import sys
import tempfile
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.dataset_record import (
    DatasetRecord,
    DatasetRecordError,
    parse_seconds,
    read_dataset_record,
)
from coding_agent_terminalbench.harbor_job import (
    JOB_CONFIG_DEFAULTS,
    RETRY_DEFAULT_MAX_RETRIES,
    ArchivePart,
    HarborJob,
    OracleRecord,
    RecordError,
    TaskOutcome,
    Trial,
    hash_archive_parts,
    provider_env_template,
    read_job,
    read_oracle_record,
    trial_completed,
)
from coding_agent_terminalbench.isolation_record import (
    evidence_problems as isolation_evidence_problems,
)
from coding_agent_terminalbench.isolation_record import record_problems as isolation_problems
from coding_agent_terminalbench.launch import KEY_VARIABLES, PROVIDER_KEY_VARIABLES, split_model
from coding_agent_terminalbench.manifest import (
    SHA256_PATTERN,
    ArtifactManifest,
    ArtifactManifestError,
    load_manifest,
)
from coding_agent_terminalbench.oracle_job import (
    DEFAULT_UV_LOCK,
    LockedPins,
    OracleJobError,
    Runner,
    config_section,
    read_locked_pins,
    resolve_release_commit,
    run_git,
    variable_names,
)
from coding_agent_terminalbench.report import build_report, format_reward
from coding_agent_terminalbench.secret_scan import (
    ScanReport,
    SecretScanError,
    read_credentials,
    read_review,
    report_text,
    scan_record,
    scan_roots,
)

RECORD_SCHEMA_VERSION = 1

MANIFEST_FILE = "manifest.json"
REPORT_FILE = "report.md"

# The agent import path that ADR 0005 §7 runs, and the profile and approval policy of ADR 0005 §3
# and §5.
ADAPTER_IMPORT_PATH = "coding_agent_terminalbench.agent:CodingAgent"
TERMINALBENCH_PROFILE = "terminalbench"
APPROVAL_POLICY = "auto-approve"

# ADR 0005 §8: GitHub requires each release asset to be under 2 GiB and allows 1,000 assets.
GITHUB_RELEASE_PART_LIMIT_BYTES = 2 * 1024**3
GITHUB_RELEASE_MAX_ASSETS = 1000

# ADR 0005 §1 pins Python 3.12 or newer, and Harbor does not record the interpreter of the job, so
# the manifest records the pin and the interpreter that ran the record command.
MINIMUM_PYTHON = "3.12"

# The fields that ADR 0005 §7's recorded-job command writes to config.json. Every other field is a
# verifier, an override, a retry or a user agent that the command does not set, so the check refuses
# it instead of guessing. Harbor records the -i task filter of the smoke and rerun jobs in
# datasets[0].task_names, not in a top level field (harbor/cli/jobs.py), so only those two jobs
# accept that field.
ALLOWED_JOB_FIELDS = frozenset(
    {"job_name", "jobs_dir", "n_concurrent_trials", "environment", "agents", "datasets"}
)
ALLOWED_AGENT_FIELDS = frozenset({"name", "import_path", "model_name", "env", "kwargs"})
# The top-level config fields that a timeout override adds, and the `harbor run` flag of each, so
# the check, the rerun comparison, the manifest's flags and its command share one source. ADR 0005
# §7 forbids a recorded job to set one; --waive-timeout-override admits them and names the waiver.
TIMEOUT_OVERRIDE_FLAGS: Mapping[str, str] = {
    "timeout_multiplier": "--timeout-multiplier",
    "agent_timeout_multiplier": "--agent-timeout-multiplier",
    "verifier_timeout_multiplier": "--verifier-timeout-multiplier",
    "agent_setup_timeout_multiplier": "--agent-setup-timeout-multiplier",
    "environment_build_timeout_multiplier": "--environment-build-timeout-multiplier",
}
TIMEOUT_OVERRIDE_FIELDS = frozenset(TIMEOUT_OVERRIDE_FLAGS)
ALLOWED_ENVIRONMENT_FIELDS = frozenset({"type"})
ALLOWED_DATASET_FIELDS = frozenset({"name", "ref"})
ALLOWED_RUN_DATASET_FIELDS = ALLOWED_DATASET_FIELDS | {"task_names"}
ALLOWED_AGENT_KWARG_NAMES = frozenset({"artifact_dir"})
FIELD_HINTS: Mapping[str, str] = {
    "n_attempts": "run with -k 1",
    "retry": "run with -r 0",
    "timeout_multiplier": "remove the timeout override",
    "agent_timeout_multiplier": "remove the agent timeout override",
}


# The checks of ADR 0005 §7. Each returns the problems it found, and no problem means the job has
# the shape that the protocol's command writes.


def unexpected_fields(
    section_name: str, value: Mapping[str, Any], allowed: frozenset[str]
) -> list[str]:
    """The fields that a command of ADR 0005 §7 does not write, with the flag that restores each."""
    problems = []
    for field in sorted(set(value) - allowed):
        path = f"{section_name}.{field}" if section_name else field
        hint = FIELD_HINTS.get(field, "remove it")
        problems.append(
            f"config.json sets {path!r}, which the job command leaves at its default ({hint})"
        )
    return problems


def agent_adapter(agent: Mapping[str, Any]) -> Any:
    """The adapter a job's agent names, in the field that Harbor or the older shape writes it."""
    return agent.get("import_path", agent.get("name"))


def agent_problems(job: HarborJob) -> list[str]:
    """The problems of a job's agent section, which ADR 0005 §7 passes as -a, -m, --ak and --ae."""
    agents = job.agents
    if len(agents) != 1 or not isinstance(agents[0], Mapping):
        return [f"the job must run exactly one agent ({ADAPTER_IMPORT_PATH})"]
    agent = agents[0]
    problems = unexpected_fields("agents[0]", agent, ALLOWED_AGENT_FIELDS)
    # Harbor 0.23.0 writes the -a value into `name`; an older shape writes the same value into
    # `import_path`. Exactly one of them must name the adapter.
    if agent.get("import_path") is not None and agent.get("name") is not None:
        problems.append(
            "config.json names the adapter by both agents[0].name and agents[0].import_path"
        )
    elif agent_adapter(agent) != ADAPTER_IMPORT_PATH:
        problems.append(
            f"the job must run the adapter at {ADAPTER_IMPORT_PATH} (-a {ADAPTER_IMPORT_PATH}), "
            f"found {agent_adapter(agent)!r}"
        )
    model_name = agent.get("model_name")
    if not isinstance(model_name, str) or model_name == "":
        problems.append("config.json has no agent model_name (-m <provider>/<model-id>)")
        return problems
    try:
        choice = split_model(model_name)
    except ValueError as exc:
        problems.append(str(exc))
        return problems

    environment = config_section(agent.get("env"))
    provider_keys = sorted(set(environment) & KEY_VARIABLES)
    if len(provider_keys) != 1:
        problems.append(
            "the agent's environment must pass exactly one provider key variable with --ae, "
            f"found {len(provider_keys)}"
        )
    else:
        variable = provider_keys[0]
        expected = provider_env_template(variable)
        if environment.get(variable) != expected:
            problems.append(
                f"the job must pass {variable} as the --ae template {variable}={expected}; "
                "config.json holds another value"
            )
        if variable not in PROVIDER_KEY_VARIABLES[choice.provider]:
            problems.append(
                f"--ae passes {variable}, but the provider {choice.provider!r} reads "
                f"{' or '.join(PROVIDER_KEY_VARIABLES[choice.provider])}"
            )
        others = sorted(set(environment) - {variable})
        if others:
            problems.append(
                "the agent's environment must pass only the provider key, found also "
                + ", ".join(others)
            )

    kwargs = config_section(agent.get("kwargs"))
    unknown = sorted(set(kwargs) - ALLOWED_AGENT_KWARG_NAMES)
    if unknown:
        problems.append(
            "config.json sets agent kwargs that the command does not pass: " + ", ".join(unknown)
        )
    artifact_dir = kwargs.get("artifact_dir")
    if not isinstance(artifact_dir, str) or artifact_dir == "":
        problems.append("config.json has no agent artifact_dir kwarg (--ak artifact_dir=<dir>)")
    return problems


def dataset_config_problems(job: HarborJob, *, allowed: frozenset[str]) -> list[str]:
    """The problems of a job's datasets section, which ADR 0005 §7 passes as one -d."""
    datasets = job.config.get("datasets")
    if not isinstance(datasets, list) or len(datasets) != 1:
        return ["the job must run exactly one dataset (one -d)"]
    dataset = config_section(datasets[0])
    problems = unexpected_fields("datasets[0]", dataset, allowed)
    name = dataset.get("name")
    if not isinstance(name, str) or name == "":
        problems.append("config.json has no dataset name")
    content_hash = dataset.get("ref")
    if (
        not isinstance(content_hash, str)
        or not content_hash.startswith("sha256:")
        or SHA256_PATTERN.fullmatch(content_hash.removeprefix("sha256:")) is None
    ):
        problems.append(
            "config.json has no dataset content hash ref; run the job with -d org/name@version"
        )
    return problems


def task_filter_problems(job: HarborJob) -> list[str]:
    """The problems of a -i task filter, which Harbor records in datasets[0].task_names."""
    names = job.dataset.get("task_names")
    if names is None:
        return []
    if not isinstance(names, list) or not all(
        isinstance(name, str) and name != "" for name in names
    ):
        return ["config.json has a datasets[0].task_names filter that is not a list of names"]
    if len(names) != len(set(names)):
        return ["config.json names a task more than once in its -i filter"]
    return []


def job_config_problems(
    job: HarborJob,
    *,
    allowed: frozenset[str],
    environment_types: set[str],
    dataset_fields: frozenset[str],
    allowed_extra: frozenset[str] = frozenset(),
) -> list[str]:
    """Compares a job's config.json with the command of ADR 0005 §7 that writes it."""
    config = job.config
    problems = unexpected_fields("", config, allowed | allowed_extra)
    # A waiver admits the timeout fields; it does not admit a value the command cannot replay.
    for field in sorted(TIMEOUT_OVERRIDE_FIELDS):
        if field in config:
            value = config[field]
            valid = not isinstance(value, bool) and isinstance(value, (int, float))
            if valid:
                try:
                    # A JSON integer beyond the float range makes `isfinite` raise.
                    valid = math.isfinite(value) and value > 0
                except OverflowError:
                    valid = False
            if not valid:
                problems.append(
                    f"config.json has a timeout override `{field}` that is not a finite "
                    f"positive number, found {value!r}"
                )
    name = config.get("job_name")
    if not isinstance(name, str) or name == "":
        problems.append("config.json has no job name (--job-name)")
    if not isinstance(job.jobs_dir, str):
        problems.append("config.json has no jobs directory (-o)")
    concurrent = job.n_concurrent_trials
    if type(concurrent) is not int or concurrent < 1:
        problems.append(f"config.json has no positive n_concurrent_trials, found {concurrent!r}")
    if job.n_attempts != JOB_CONFIG_DEFAULTS["n_attempts"]:
        problems.append("the job must run one attempt per task; config.json sets n_attempts (-k 1)")
    if job.max_retries != RETRY_DEFAULT_MAX_RETRIES:
        problems.append("the job must not retry a trial with Harbor; config.json sets retry (-r 0)")
    environment = config_section(config.get("environment"))
    problems.extend(unexpected_fields("environment", environment, ALLOWED_ENVIRONMENT_FIELDS))
    expected_environment = job.environment_type
    if expected_environment not in environment_types:
        proposals = " or ".join(sorted(environment_types))
        problems.append(
            f"the job must run on {proposals} (-e), found {expected_environment!r}"
        )
    problems.extend(agent_problems(job))
    problems.extend(dataset_config_problems(job, allowed=dataset_fields))
    problems.extend(task_filter_problems(job))
    return problems


def recorded_job_problems(job: HarborJob, allowed_extra: frozenset[str]) -> list[str]:
    """The problems of the recorded job's config.json (ADR 0005 §7 step 4)."""
    problems = job_config_problems(
        job,
        allowed=ALLOWED_JOB_FIELDS,
        environment_types={"modal"},
        dataset_fields=ALLOWED_DATASET_FIELDS,
        allowed_extra=allowed_extra,
    )
    if job.task_filter():
        problems.append("the recorded job must run every task; config.json has a -i task filter")
    return problems


def rerun_job_problems(
    recorded: HarborJob, rerun: HarborJob, allowed_extra: frozenset[str]
) -> list[str]:
    """The problems of the rerun job's config.json (ADR 0005 §7 step 5)."""
    problems = job_config_problems(
        rerun,
        allowed=ALLOWED_JOB_FIELDS,
        environment_types={"modal"},
        dataset_fields=ALLOWED_RUN_DATASET_FIELDS,
        allowed_extra=allowed_extra,
    )
    expected_name = recorded.name + "-rerun"
    if rerun.name != expected_name:
        problems.append(
            f"the rerun job must be named {expected_name!r} (--job-name {expected_name}), "
            f"found {rerun.name!r}"
        )
    problems.extend(related_job_problems(recorded, rerun, "the rerun job"))
    return problems


def smoke_job_problems(
    recorded: HarborJob, smoke: HarborJob, allowed_extra: frozenset[str]
) -> list[str]:
    """The problems of the smoke job's config.json (ADR 0005 §7 step 3)."""
    problems = job_config_problems(
        smoke,
        allowed=ALLOWED_JOB_FIELDS,
        environment_types={"modal", "docker"},
        dataset_fields=ALLOWED_RUN_DATASET_FIELDS,
        allowed_extra=allowed_extra,
    )
    problems.extend(related_job_problems(recorded, smoke, "the smoke job"))
    return problems


def related_job_problems(recorded: HarborJob, job: HarborJob, label: str) -> list[str]:
    """The ways a smoke or rerun job does not repeat the recorded job's conditions."""
    problems = []
    if job.dataset_pin != recorded.dataset_pin:
        problems.append(f"{label} must run the same dataset as the recorded job")
    if agent_adapter(job.agent) != agent_adapter(recorded.agent):
        problems.append(f"{label} must use the recorded job's adapter")
    for field, value in (
        ("model_name", recorded.agent.get("model_name")),
        ("env", recorded.agent.get("env")),
        ("kwargs", recorded.agent.get("kwargs")),
    ):
        if job.agent.get(field) != value:
            problems.append(f"{label} must use the recorded job's agents[0].{field}")
    if label == "the rerun job":
        if job.environment_type != recorded.environment_type:
            problems.append(f"{label} must use the recorded job's environment")
        # A rerun repeats the recorded job's flags, so a timeout override must be the same.
        for field in sorted(TIMEOUT_OVERRIDE_FIELDS):
            if job.config.get(field) != recorded.config.get(field):
                problems.append(
                    f"{label} must use the recorded job's {field}: "
                    f"{job.config.get(field)!r} is not {recorded.config.get(field)!r}"
                )
    return problems


def pinned_job_problems(job: HarborJob, pins: LockedPins, label: str) -> list[str]:
    """The Harbor version the job ran, checked against uv.lock (ADR 0005 §1)."""
    if job.harbor_version == pins.harbor:
        return []
    return [
        f"{label} ran Harbor {job.harbor_version}, but uv.lock pins {pins.harbor}; run it through "
        "uv run --project evaluation/terminalbench --frozen"
    ]


def job_result_problems(job: HarborJob, label: str) -> list[str]:
    """The job result's identity and times (harbor/models/job/result.py)."""
    result = job.result
    problems = []
    if not isinstance(result.get("id"), str) or result.get("id") == "":
        problems.append(f"{label} has no job id in result.json")
    if job.started_at() is None:
        problems.append(f"{label} has no started_at time that can be read")
    if result.get("finished_at") is None:
        problems.append(f"{label} did not finish: result.json has no finished_at")
    elif job.finished_at() is None:
        problems.append(f"{label} has a finished_at time that cannot be read")
    if job.started_at() is not None and job.finished_at() is not None:
        seconds = job.wall_clock_seconds()
        if seconds is None:
            problems.append(f"{label} result.json must record its times with a time zone")
        elif seconds < 0:
            problems.append(f"{label} result.json has a finished_at time before its started_at")
    return problems


def job_trial_problems(job: HarborJob, label: str) -> list[str]:
    """The trials of a job, checked against the trials its lock.json plans."""
    problems = [
        f"{label} trial {trial} did not finish: it has no result.json"
        for trial in job.unfinished_trials
    ]
    planned = job.planned_tasks()
    if not planned:
        problems.append(f"{label} lock.json plans no trial")
    planned_count = len(job.planned_trials)
    if job.result.get("n_total_trials") != planned_count:
        problems.append(
            f"{label} result.json counts {job.result.get('n_total_trials')} trials, "
            f"lock.json plans {planned_count}"
        )
    if len(job.trials) != planned_count:
        problems.append(
            f"{label} has {len(job.trials)} finished trials, lock.json plans {planned_count}"
        )
    planned_digests = dict(planned)
    for trial in job.trials:
        digest = planned_digests.get(trial.task)
        if digest is None:
            problems.append(
                f"{label} trial {trial.name} ran task {trial.task}, which this job does not plan"
            )
        elif trial.digest != digest:
            problems.append(
                f"{label} trial {trial.name} ran {trial.task} at digest {trial.digest}, "
                f"but the job plans {digest}"
            )
    ran_tasks = [trial.task for trial in job.trials]
    if len(ran_tasks) != len(set(ran_tasks)):
        problems.append(f"{label} has more than one finished trial of a task; it must run -k 1")
    return problems


def artifact_problems(
    artifact: ArtifactManifest, jobs: Sequence[tuple[HarborJob, str]]
) -> list[str]:
    """The built artifact, checked against what its trials recorded (ADR 0005 §2 and §6)."""
    problems = []
    if artifact.dirty:
        problems.append(
            "the artifact was built from a dirty working tree; ADR 0005 §2 evaluates a commit "
            "on main with a clean tree"
        )
    hashes = {executable.file: executable.sha256 for executable in artifact.executables}
    for job, label in jobs:
        for trial in job.trials:
            if trial.run is None:
                continue
            if trial.run.version != artifact.version or trial.run.commit != artifact.commit:
                problems.append(
                    f"{label} trial {trial.name} ran Coding Agent {trial.run.version} "
                    f"{trial.run.commit}, but artifact-manifest.json records {artifact.version} "
                    f"{artifact.commit}"
                )
            recorded = dict(trial.artifact_sha256)
            if recorded and dict(recorded) != hashes:
                problems.append(
                    f"{label} trial {trial.name} recorded artifact SHA-256 values that differ "
                    "from artifact-manifest.json"
                )
            if trial.installed_executable is not None and trial.installed_executable not in hashes:
                problems.append(
                    f"{label} trial {trial.name} installed {trial.installed_executable!r}, "
                    "which artifact-manifest.json does not name"
                )
    return problems


def run_problems(jobs: Sequence[tuple[HarborJob, str]]) -> list[str]:
    """The Coding Agent runs of the job's trials: one profile, provider, model and sampling.

    The recorded, smoke and rerun jobs must repeat the same profile, provider and model, because a
    rerun outcome replaces a recorded one. A rerun trial can fail setup before Coding Agent starts,
    and it then has no run.json, so only the runs that exist are compared.
    """
    problems: list[str] = []
    runs = [(trial.run, label, trial) for job, label in jobs for trial in job.trials if trial.run]
    if not runs:
        return [
            "the job's trials carry no Coding Agent run.json, so the profile, provider, model and "
            "sampling settings cannot be recorded"
        ]
    first = runs[0][0]
    assert first is not None
    values = {
        "profile": first.profile,
        "provider": first.provider,
        "model": first.model,
        "sampling": (
            json.dumps(first.sampling, sort_keys=True) if first.sampling is not None else None
        ),
        "limits": json.dumps(first.limits, sort_keys=True),
    }
    for run, label, trial in runs:
        assert run is not None
        if run.profile != values["profile"]:
            problems.append(
                f"{label} trial {trial.name} ran profile {run.profile!r}; every trial of the job "
                f"must run the same profile, found {values['profile']!r}"
            )
        if run.provider != values["provider"] or run.model != values["model"]:
            problems.append(
                f"{label} trial {trial.name} ran {run.provider}/{run.model}; the job must run one "
                "provider and model"
            )
        if run.approval_policy != APPROVAL_POLICY:
            problems.append(
                f"{label} trial {trial.name} ran the approval policy {run.approval_policy!r}; "
                f"ADR 0005 §3 mandates {APPROVAL_POLICY}"
            )
        sampling = json.dumps(run.sampling, sort_keys=True) if run.sampling is not None else None
        if sampling != values["sampling"]:
            problems.append(
                f"{label} trial {trial.name} ran sampling settings that differ from the job's"
            )
        if json.dumps(run.limits, sort_keys=True) != values["limits"]:
            problems.append(
                f"{label} trial {trial.name} ran SessionLimits that differ from the job's"
            )
    if values["profile"] != TERMINALBENCH_PROFILE:
        problems.append(
            f"the job must run the {TERMINALBENCH_PROFILE} profile (ADR 0005 §5), "
            f"found {values['profile']!r}"
        )
    return problems


def model_problems(job: HarborJob) -> list[str]:
    """The provider and model of config.json against the one each trial's run.json records."""
    try:
        choice = split_model(job.model_name)
    except ValueError as exc:
        return [str(exc)]
    problems = []
    for trial in job.trials:
        if trial.run is None:
            continue
        if trial.run.provider != choice.provider or trial.run.model != choice.model:
            problems.append(
                f"trial {trial.name} ran {trial.run.provider}/{trial.run.model}, but the job ran "
                f"-m {job.model_name}"
            )
    return problems


def short_name(task: str) -> str:
    """A task name without its org: lock.json writes org/name, ADR 0008 §4 writes name."""
    return task.rpartition("/")[2]


def dataset_problems(
    dataset: DatasetRecord,
    oracle: OracleRecord,
    recorded: HarborJob,
    smoke: HarborJob,
    rerun: HarborJob | None,
) -> list[str]:
    """The job's dataset against its committed record (ADR 0008 §1 and §4).

    ADR 0008 §4 records a task by its name, while Harbor's lock.json writes org/name, so the
    comparison is on short names. That assumes no two tasks of one dataset share a short name.
    """
    problems = []
    name = recorded.dataset.get("name")
    if name != dataset.package_name:
        problems.append(
            f"the job ran dataset {name!r}, but its record is {dataset.identifier}"
        )
    content_hash = recorded.dataset.get("ref")
    if oracle.content_hash is None:
        problems.append(
            f"{oracle.job} records no dataset content hash, so the job's dataset pin cannot be "
            "checked against its oracle job"
        )
    elif content_hash != oracle.content_hash:
        problems.append(
            f"the job ran dataset content {content_hash}, but {oracle.job} resolved "
            f"{oracle.content_hash}; a job on another pin cannot be recorded with this pin's "
            "oracle job"
        )
    for job, label in ((smoke, "the smoke job"), (rerun, "the rerun job")):
        if job is not None and job.dataset_pin != recorded.dataset_pin:
            problems.append(f"{label} ran another dataset than the recorded job")
    tasks = {short_name(task) for task, _ in recorded.planned_tasks()}
    smoke_set = {short_name(task) for task in dataset.smoke_tasks}
    missing_smoke = sorted(smoke_set - tasks)
    if missing_smoke:
        problems.append(
            f"the record's smoke tasks are not in the job's resolved task list: "
            + ", ".join(missing_smoke)
        )
    for label, entries in (
        ("MCP servers", dataset.mcp_server_tasks),
        ("skills directories", dataset.skills_tasks),
    ):
        missing = sorted({short_name(task) for task in entries} - tasks)
        if missing:
            problems.append(
                f"the record names tasks with {label} that the job did not run: "
                + ", ".join(missing)
            )
    smoke_tasks = {short_name(task) for task, _ in smoke.planned_tasks()}
    if smoke_tasks != smoke_set:
        problems.append(
            "the smoke job must run the smoke set that the dataset record names; it ran "
            + (", ".join(sorted(smoke_tasks)) or "no task")
        )
    return problems


def release_commit_problems(dataset: DatasetRecord, resolved: str) -> list[str]:
    """The release tag and commit that the dataset record names (ADR 0008 §1)."""
    if resolved == dataset.release_commit:
        return []
    return [
        f"tag {dataset.release_tag} of {dataset.source_repository} resolves to {resolved}, but "
        f"{dataset.path} names {dataset.release_commit}"
    ]


def oracle_problems(oracle: OracleRecord, dataset: DatasetRecord, recorded: HarborJob) -> list[str]:
    """The oracle job's record against the recorded job's dataset (ADR 0005 §7 step 2)."""
    problems = []
    if oracle.dataset != dataset.identifier:
        problems.append(
            f"the oracle record describes {oracle.dataset}, but the recorded job ran "
            f"{dataset.identifier}; the harness-flaky tasks would describe another pin"
        )
    tasks = {task for task, _ in recorded.planned_tasks()}
    unknown = sorted(
        str(entry.get("name"))
        for entry in oracle.harness_flaky
        if entry.get("name") not in tasks
    )
    if unknown:
        problems.append(
            "the oracle record names harness-flaky tasks that the job did not run: "
            + ", ".join(unknown)
        )
    return problems


def archive_problems(parts: Sequence[ArchivePart]) -> list[str]:
    """The archive parts, bounded as GitHub release assets are (ADR 0005 §8)."""
    problems = []
    if not parts:
        problems.append(
            "the record needs at least one --archive-part: the manifest records the SHA-256 of "
            "every part of the published archive"
        )
    names = Counter(part.file for part in parts)
    duplicates = sorted(name for name, count in names.items() if count > 1)
    if duplicates:
        problems.append(
            "two archive parts share a file name, so a GitHub release cannot hold both: "
            + ", ".join(duplicates)
        )
    if len(parts) > GITHUB_RELEASE_MAX_ASSETS:
        problems.append(
            f"the archive has {len(parts)} parts, but a GitHub release allows at most "
            f"{GITHUB_RELEASE_MAX_ASSETS} assets"
        )
    for part in parts:
        if part.bytes >= GITHUB_RELEASE_PART_LIMIT_BYTES:
            problems.append(
                f"{part.file} is {part.bytes} bytes; a GitHub release asset must be under 2 GiB"
            )
    return problems


@dataclass(frozen=True)
class RecordInputs:
    """The jobs and committed inputs that the protocol checks read (ADR 0005 §7 and §8)."""

    recorded: HarborJob
    rerun: HarborJob | None
    smoke: HarborJob
    oracle: OracleRecord
    dataset: DatasetRecord
    artifact: ArtifactManifest
    pins: LockedPins
    release_commit: str
    archive_parts: tuple[ArchivePart, ...]
    # The committed Isolation Record of the artifact (ADR 0005 §7 item 3), or None when no file
    # was given, which a waiver allows and a malformed `{}` file does not.
    isolation_record: Mapping[str, Any] | None
    # Why the record waives §7's credential isolation precondition, or None when it does not.
    isolation_waiver: str | None = None
    # Why the record waives resolving the dataset's release tag, or None when it does not.
    release_tag_waiver: str | None = None
    # Why the record waives ADR 0005 §7's ban on a timeout override, or None when it does not.
    timeout_waiver: str | None = None


def isolation_record_problems(inputs: RecordInputs) -> list[str]:
    """Why the isolation test does not clear the backends that these jobs ran on.

    A waiver lifts the clearance condition, not the evidence (review of PR #118): a file that was
    given, even `{}`, still has to be a record of this artifact, and only a missing file is
    accepted.
    """
    if inputs.isolation_waiver is not None:
        if inputs.isolation_record is None:
            return []
        return isolation_evidence_problems(dict(inputs.isolation_record), inputs.artifact)
    if inputs.isolation_record is None:
        return ["there is no Isolation Record"]
    jobs = [inputs.recorded, inputs.smoke, *([inputs.rerun] if inputs.rerun is not None else [])]
    backends = sorted({str(job.environment_type) for job in jobs})
    return isolation_problems(
        dict(inputs.isolation_record), inputs.artifact, inputs.dataset.identifier, backends
    )


def protocol_problems(inputs: RecordInputs) -> list[str]:
    """Every way the jobs break ADR 0005 §7, or differ from their records."""
    recorded = inputs.recorded
    rerun = inputs.rerun
    smoke = inputs.smoke
    dataset = inputs.dataset
    allowed_extra = TIMEOUT_OVERRIDE_FIELDS if inputs.timeout_waiver else frozenset()
    problems = [
        *recorded_job_problems(recorded, allowed_extra),
        *smoke_job_problems(recorded, smoke, allowed_extra),
        *pinned_job_problems(recorded, inputs.pins, "the recorded job"),
        *pinned_job_problems(smoke, inputs.pins, "the smoke job"),
        *job_result_problems(recorded, "the recorded job"),
        *job_result_problems(smoke, "the smoke job"),
        *job_trial_problems(recorded, "the recorded job"),
        *job_trial_problems(smoke, "the smoke job"),
        *dataset_problems(dataset, inputs.oracle, recorded, smoke, rerun),
        *(
            []
            if inputs.release_tag_waiver
            else release_commit_problems(dataset, inputs.release_commit)
        ),
        *oracle_problems(inputs.oracle, dataset, recorded),
        *model_problems(recorded),
        *artifact_problems(
            inputs.artifact, [(recorded, "the recorded job"), (smoke, "the smoke job")]
        ),
        *run_problems(
            [
                (recorded, "the recorded job"),
                (smoke, "the smoke job"),
                *([(rerun, "the rerun job")] if rerun is not None else []),
            ]
        ),
        *archive_problems(inputs.archive_parts),
        *isolation_record_problems(inputs),
    ]
    if rerun is not None:
        problems.extend(
            [
                *rerun_job_problems(recorded, rerun, allowed_extra),
                *pinned_job_problems(rerun, inputs.pins, "the rerun job"),
                *job_result_problems(rerun, "the rerun job"),
                *job_trial_problems(rerun, "the rerun job"),
                *artifact_problems(inputs.artifact, [(rerun, "the rerun job")]),
            ]
        )
    return problems


def trials_by_task(job: HarborJob, label: str) -> dict[str, Trial]:
    """The one finished trial of each task, or an error when a task has several."""
    by_task: dict[str, Trial] = {}
    for trial in job.trials:
        if trial.task in by_task:
            raise RecordError(
                f"{label} has more than one finished trial of {trial.task}; ADR 0005 §7 runs -k 1"
            )
        by_task[trial.task] = trial
    return by_task


def task_outcomes(recorded: HarborJob, rerun: HarborJob | None) -> tuple[TaskOutcome, ...]:
    """The recorded outcome of each task of the recorded job (ADR 0005 §7)."""
    originals = trials_by_task(recorded, "the recorded job")
    reruns = trials_by_task(rerun, "the rerun job") if rerun is not None else {}
    outcomes: list[TaskOutcome] = []
    for task, digest in recorded.planned_tasks():
        original = originals.get(task)
        if original is None:
            raise RecordError(
                f"the recorded job has no finished trial of {task}; a recorded job runs every task"
            )
        recorded_trial = original if trial_completed(original) else reruns.get(task)
        outcomes.append(
            TaskOutcome(task=task, digest=digest, original=original, recorded=recorded_trial)
        )
    return tuple(outcomes)


def session_bound_seconds(recorded: HarborJob) -> int | None:
    """The maxDurationMs of the profile the job ran, in seconds (ADR 0005 §5)."""
    for trial in recorded.trials:
        limits = trial.run.limits if trial.run is not None else {}
        value = limits.get("maxDurationMs")
        if type(value) is int:
            return value // 1000
    return None


def dataset_properties(
    dataset: DatasetRecord, recorded: HarborJob
) -> tuple[Mapping[str, Any], ...]:
    """The evidence for each ADR 0008 §3 property, with the job's own checks of it."""
    bound = session_bound_seconds(recorded)
    entries: list[Mapping[str, Any]] = []
    for property_evidence in dataset.properties:
        problems = dataset_property_problems(property_evidence.name, dataset, recorded, bound)
        entries.append(
            {
                "property": property_evidence.name,
                "label": property_evidence.label,
                "evidence": property_evidence.evidence,
                "source": property_evidence.source,
                "shown": property_evidence.shown,
                "problems": problems,
            }
        )
    return tuple(entries)


def dataset_property_problems(
    name: str, dataset: DatasetRecord, recorded: HarborJob, bound: int | None
) -> list[str]:
    """The job's own evidence against one dataset property, or nothing when it agrees."""
    if name == "single-step-tasks":
        return [
            f"trial {trial.name} of {trial.task} has step results, but ADR 0008 §3 requires "
            "single-step tasks"
            for trial in recorded.trials
            if trial.multi_step
        ]
    if name == "separate-verifier-environment":
        return [
            f"trial {trial.name} of {trial.task} records verifier environment mode "
            f"{trial.verifier_environment_mode!r}, not 'separate'"
            for trial in recorded.trials
            if trial.verifier_environment_mode != "separate"
        ]
    if name == "per-task-agent-timeout":
        evidence = dataset.property(name).evidence or ""
        seconds = parse_seconds(evidence)
        if seconds is None:
            return [f"the per-task agent timeout row states no number of seconds: {evidence!r}"]
        if bound is None:
            return [
                "the recorded trials carry no maxDurationMs, so the timeout bound cannot be "
                "checked"
            ]
        if seconds < bound:
            return [
                f"the dataset declares a {seconds} s per-task agent timeout, below the profile's "
                f"{bound} s maxDurationMs"
            ]
        return []
    return []


# The record as a whole: the jobs, the dataset record, the scan and the computed outcomes.


@dataclass(frozen=True)
class RecordData:
    """Everything that manifest.json and report.md are built from."""

    recorded: HarborJob
    rerun: HarborJob | None
    smoke: HarborJob
    oracle: OracleRecord
    dataset: DatasetRecord
    artifact: ArtifactManifest
    pins: LockedPins
    release_commit: str
    archive_parts: tuple[ArchivePart, ...]
    isolation_record: Mapping[str, Any]
    isolation_waiver: str | None
    release_tag_waiver: str | None
    timeout_waiver: str | None
    scan: ScanReport
    outcomes: tuple[TaskOutcome, ...]
    properties: tuple[Mapping[str, Any], ...]
    validity_problems: tuple[str, ...]
    mean: Mapping[str, float]

    @property
    def valid(self) -> bool:
        return not self.validity_problems

    @property
    def rerun_eligible(self) -> tuple[TaskOutcome, ...]:
        return tuple(outcome for outcome in self.outcomes if outcome.original.rerun_eligible)

    @property
    def profile_name(self) -> str | None:
        return self.recorded.profile_name

    @property
    def provider(self) -> str | None:
        return self.recorded.model_choice[0]

    @property
    def model(self) -> str | None:
        return self.recorded.model_choice[1]

    def rerun_trials(self) -> Mapping[str, Trial]:
        """The finished trial of each task in the rerun job, or nothing when there is no rerun."""
        if self.rerun is None:
            return {}
        return trials_by_task(self.rerun, "the rerun job")


def harbor_mean(
    rewards: Sequence[Mapping[str, float | int] | None],
) -> Mapping[str, float]:
    """The mean of ADR 0005 §8, computed as Harbor's Mean metric computes it.

    Harbor's aggregate_reward_dicts counts a trial without a reward as 0. With one reward key it
    reports one mean; with several it reports one mean per key
    (harbor/metrics/base.py at 1e5c5c6). One task has one recorded outcome.
    """
    if not rewards:
        return {}
    keys = sorted({key for reward in rewards if reward is not None for key in reward})
    if len(keys) <= 1:
        values = [0 if reward is None else next(iter(reward.values()), 0) for reward in rewards]
        return {"mean": sum(values) / len(values)}
    return {
        key: sum(0 if reward is None else reward.get(key, 0) for reward in rewards) / len(rewards)
        for key in keys
    }


def environment_variable_names(*jobs: HarborJob | None) -> tuple[str, ...]:
    """The names, never the values, of the variables that the jobs pass (ADR 0005 §8)."""
    names: set[str] = set()
    for job in jobs:
        if job is not None:
            names.update(variable_names(job.config))
    return tuple(sorted(names))


def build_record_data(inputs: RecordInputs, scan: ScanReport) -> RecordData:
    """Computes the recorded outcomes, the properties, the validity and the mean."""
    recorded = inputs.recorded
    rerun = inputs.rerun
    dataset = inputs.dataset
    outcomes = task_outcomes(recorded, rerun)
    properties = dataset_properties(dataset, recorded)
    problems: list[str] = list(dataset.admissibility_problems)
    for entry in properties:
        problems.extend(str(problem) for problem in entry["problems"])
    rerun_tasks = set(trials_by_task(rerun, "the rerun job")) if rerun is not None else set()
    selected = {outcome.task for outcome in outcomes if outcome.original.rerun_eligible}
    for outcome in outcomes:
        if outcome.recorded is None:
            has_reason = outcome.original.rerun_reason or "no verifier reward"
            problems.append(
                f"task {outcome.task} has no completed trial: its recorded trial has "
                f"{has_reason}, and the rerun job did not run it"
            )
        elif not outcome.completed:
            has_reason = outcome.recorded.rerun_reason or "no verifier reward"
            problems.append(
                f"task {outcome.task} has no completed trial: its rerun trial has "
                f"{has_reason}, and a rerun trial is never rerun"
            )
    unexpected = sorted(rerun_tasks - selected)
    if unexpected:
        problems.append(
            "the rerun job ran tasks that the recorded job did not select for a rerun: "
            + ", ".join(unexpected)
        )
    # A waiver is a protocol requirement the record does not show, so the record is not valid and
    # publishes no headline reward even when every trial has a reward (review of PR #118).
    for check, reason in (
        ("credential isolation", inputs.isolation_waiver),
        ("the dataset release tag", inputs.release_tag_waiver),
        ("the timeout override", inputs.timeout_waiver),
    ):
        if reason is not None:
            problems.append(f"the record waives {check}: {reason}")
    mean = harbor_mean(
        [outcome.recorded.reward if outcome.recorded is not None else None for outcome in outcomes]
    )
    return RecordData(
        recorded=inputs.recorded,
        rerun=inputs.rerun,
        smoke=inputs.smoke,
        oracle=inputs.oracle,
        dataset=inputs.dataset,
        artifact=inputs.artifact,
        pins=inputs.pins,
        release_commit=inputs.release_commit,
        archive_parts=inputs.archive_parts,
        isolation_record=inputs.isolation_record or {},
        isolation_waiver=inputs.isolation_waiver,
        release_tag_waiver=inputs.release_tag_waiver,
        timeout_waiver=inputs.timeout_waiver,
        scan=scan,
        outcomes=outcomes,
        properties=properties,
        validity_problems=tuple(problems),
        mean=mean,
    )


def release_commit_resolved_by(dataset: DatasetRecord, waiver: str | None = None) -> str:
    """The command that resolves the release tag to its commit (ADR 0008 §1).

    A record that waives the resolution names the commit it recorded and the reason instead.
    """
    if waiver is not None:
        return f"recorded in {dataset.path}: {waiver}"
    ref = f"refs/tags/{dataset.release_tag}"
    return f"git ls-remote --tags {dataset.source_repository} {ref} {ref}^{{}}"


def installed_executables(jobs: Sequence[HarborJob]) -> Mapping[str, int]:
    """How often each executable of the artifact ran, from the trials' context metadata."""
    counts = Counter(
        trial.installed_executable
        for job in jobs
        for trial in job.trials
        if trial.installed_executable is not None
    )
    return dict(sorted(counts.items()))


def run_command(job: HarborJob, dataset: DatasetRecord) -> str:
    """The harbor run command of ADR 0005 §7 that writes the job's config.json."""
    artifact_dir = job.agent_kwargs.get("artifact_dir")
    parts = [
        "harbor run",
        f"-d {dataset.identifier}",
        f"-a {ADAPTER_IMPORT_PATH}",
        f"-m {job.model_name}",
        f"--ak artifact_dir={artifact_dir}",
    ]
    for variable in sorted(job.agent_environment):
        parts.append("--ae " + variable + "=" + repr(provider_env_template(variable)))
    parts += [
        f"-e {job.environment_type}",
        f"-k {job.n_attempts}",
        f"-n {job.n_concurrent_trials}",
        f"-r {job.max_retries}",
    ]
    for field in sorted(TIMEOUT_OVERRIDE_FIELDS):
        if field in job.config:
            parts.append(f"{TIMEOUT_OVERRIDE_FLAGS[field]} {job.config[field]}")
    for task in job.task_filter():
        parts.append(f"-i {task}")
    parts += [f"-o {job.jobs_dir}", f"--job-name {job.name}"]
    return " ".join(parts)


def job_flags(job: HarborJob) -> Mapping[str, Any]:
    """Every Harbor flag that the recorded job used, with the defaults the command relies on."""
    flags: dict[str, Any] = {
        "agent": agent_adapter(job.agent),
        "agentKwargs": dict(job.agent_kwargs),
        "model": job.model_name,
        "environment": job.environment_type,
        "nAttempts": job.n_attempts,
        "nConcurrentTrials": job.n_concurrent_trials,
        "maxRetries": job.max_retries,
        "taskFilter": list(job.task_filter()),
        "jobsDir": job.jobs_dir,
        "jobName": job.name,
    }
    for field in sorted(TIMEOUT_OVERRIDE_FIELDS):
        if field in job.config:
            flags[field] = job.config[field]
    return flags


def dataset_section(data: RecordData) -> Mapping[str, Any]:
    """The dataset record of ADR 0008 that the manifest carries (ADR 0005 §8)."""
    return {
        "identifier": data.dataset.identifier,
        "contentHash": data.recorded.dataset.get("ref"),
        "sourceRepository": data.dataset.source_repository,
        "releaseTag": data.dataset.release_tag,
        "releaseCommit": data.release_commit,
        "releaseCommitResolvedBy": release_commit_resolved_by(
            data.dataset, data.release_tag_waiver
        ),
        "taskCount": len(data.outcomes),
        "taskList": [
            {"name": outcome.task, "digest": outcome.digest} for outcome in data.outcomes
        ],
        "smokeTasks": list(data.dataset.smoke_tasks),
        "record": {
            "path": data.dataset.path,
            "rows": dict(data.dataset.rows),
        },
        "properties": list(data.properties),
        "ignoredDeclarations": {
            "mcpServers": list(data.dataset.mcp_server_tasks),
            "skillsDirectories": list(data.dataset.skills_tasks),
        },
    }


def artifact_section(data: RecordData) -> Mapping[str, Any]:
    jobs = [data.recorded, data.smoke, *([data.rerun] if data.rerun is not None else [])]
    return {
        "version": data.artifact.version,
        "commit": data.artifact.commit,
        "dirty": data.artifact.dirty,
        "bunVersion": data.artifact.bun_version,
        "executables": [
            {"file": executable.file, "target": executable.target, "sha256": executable.sha256}
            for executable in data.artifact.executables
        ],
        "installedExecutables": installed_executables(jobs),
    }


def manifest_data(data: RecordData) -> Mapping[str, Any]:
    """The manifest.json of ADR 0005 §8. It holds no credential value, only variable names."""
    job = data.recorded
    profile_name, limits = job.profile_name, job.limits
    provider, model = job.model_choice
    sampling = job.sampling
    return {
        "schemaVersion": RECORD_SCHEMA_VERSION,
        "job": {
            "name": job.name,
            "id": job.result.get("id"),
            "startedAt": job.result.get("started_at"),
            "finishedAt": job.result.get("finished_at"),
            "wallClockSeconds": job.wall_clock_seconds(),
        },
        "command": run_command(job, data.dataset),
        "pins": {
            "harbor": {
                "version": job.harbor_version,
                "gitCommitHash": job.harbor_git_commit,
            },
            "modalSdk": {"version": data.pins.modal, "source": "uv.lock"},
            "python": {"minimum": MINIMUM_PYTHON, "used": platform.python_version()},
        },
        "artifact": artifact_section(data),
        "profile": {"name": profile_name, "limits": dict(limits)},
        "model": {
            "provider": provider,
            "model": model,
            "sampling": dict(sampling) if sampling is not None else None,
        },
        "flags": job_flags(job),
        "environmentVariableNames": list(environment_variable_names(job, data.rerun, data.smoke)),
        "dataset": dataset_section(data),
        "relatedJobs": {
            "oracle": data.oracle.job,
            "smoke": data.smoke.name,
            "rerun": data.rerun.name if data.rerun is not None else None,
        },
        "credentialIsolation": dict(data.isolation_record),
        "waivers": [
            *(
                [{"check": "credential-isolation", "reason": data.isolation_waiver}]
                if data.isolation_waiver is not None
                else []
            ),
            *(
                [{"check": "dataset-release-tag", "reason": data.release_tag_waiver}]
                if data.release_tag_waiver is not None
                else []
            ),
            *(
                [{"check": "timeout-override", "reason": data.timeout_waiver}]
                if data.timeout_waiver is not None
                else []
            ),
        ],
        "secretScan": scan_record(data.scan),
        "archive": {
            "parts": [
                {"file": part.file, "bytes": part.bytes, "sha256": part.sha256}
                for part in data.archive_parts
            ],
            "assetLimitBytes": GITHUB_RELEASE_PART_LIMIT_BYTES,
            "assetCountLimit": GITHUB_RELEASE_MAX_ASSETS,
        },
    }


# Writing the record and the command line.


def write_text_file(path: Path, text: str) -> None:
    """Writes a text file through a temporary file, so a failed write leaves nothing partial."""
    temporary: str | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix="." + path.name + ".", delete=False
        ) as file:
            temporary = file.name
            file.write(text)
        os.replace(temporary, path)
    except OSError as exc:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
        raise RecordError(f"cannot write {path}: {exc}") from exc


def write_record_files(output_dir: Path, manifest: Mapping[str, Any], report: str) -> None:
    """Writes manifest.json and report.md, and nothing else into the output directory.

    A record is the two files together, so a failed write removes the file that the failed command
    already wrote: the output directory never holds half a record.
    """
    manifest_path = output_dir / MANIFEST_FILE
    report_path = output_dir / REPORT_FILE
    manifest_text = json.dumps(manifest, indent=2, allow_nan=False) + "\n"
    written: list[Path] = []
    try:
        write_text_file(manifest_path, manifest_text)
        written.append(manifest_path)
        write_text_file(report_path, report)
    except RecordError:
        for path in written:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                # The output directory is not usable; the caller reports the first failure.
                pass
        raise


def credential_leak_problems(
    manifest_text: str, report_text: str, credentials: Mapping[str, str]
) -> list[str]:
    """Refuses a record that would hold a credential value, whatever produced it.

    The scan searches the job directories, and this check covers the record itself: a review
    reason, a dataset row or any other written text that happens to hold a credential value stops
    the record before it is written. ADR 0005 §8 requires the manifest to hold no credential value.
    """
    problems = []
    for variable in sorted(credentials):
        value = credentials[variable]
        if value and (value in manifest_text or value in report_text):
            problems.append(
                f"{variable} would appear in the record's text; refusing to write a credential "
                "value, even with its variable's name"
            )
    return problems


def summary_text(data: RecordData) -> str:
    """A plain text summary for the person who ran the record command."""
    job = data.recorded
    if len(data.mean) <= 1:
        mean = format_reward(data.mean.get("mean", 0))
    else:
        mean = ", ".join(
            f"{key}={format_reward(value)}" for key, value in sorted(data.mean.items())
        )
    return "\n".join(
        [
            f"Recorded job {job.name} on {data.dataset.identifier} ({data.release_commit})",
            f"Harbor {job.harbor_version}, artifact {data.artifact.version} {data.artifact.commit}",
            f"Tasks: {len(data.outcomes)}, mean reward: {mean}, "
            f"valid: {'yes' if data.valid else 'no'}",
            f"Rerun-eligible: {len(data.rerun_eligible)}, "
            f"harness-flaky: {len(data.oracle.harness_flaky)}",
            f"Secret scan: {data.scan.files_scanned} files, "
            f"{'passed' if data.scan.passed else 'failed'}",
            *(
                [f"Waived credential isolation: {data.isolation_waiver}"]
                if data.isolation_waiver is not None
                else []
            ),
            *(
                [f"Waived dataset release tag: {data.release_tag_waiver}"]
                if data.release_tag_waiver is not None
                else []
            ),
            *(
                [f"Waived timeout override: {data.timeout_waiver}"]
                if data.timeout_waiver is not None
                else []
            ),
        ]
    )


def scan_credential_names(
    recorded: HarborJob, rerun: HarborJob | None, smoke: HarborJob, extra: Sequence[str]
) -> tuple[str, ...]:
    """The variables whose values the scan searches for: the provider keys the jobs passed."""
    names = {
        name
        for job in (recorded, rerun, smoke)
        if job is not None
        for name in job.agent_environment
        if name in KEY_VARIABLES
    }
    names.update(extra)
    return tuple(sorted(names))


def main(
    argv: Sequence[str] | None = None,
    *,
    run: Runner = run_git,
    environment: Mapping[str, str] | None = None,
) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m coding_agent_terminalbench.record",
        description=(
            "Check a finished TerminalBench recorded job against ADR 0005 §7 and write its "
            "manifest.json and report.md."
        ),
    )
    parser.add_argument("job_dir", type=Path, help="the recorded job's Harbor job directory")
    parser.add_argument("--rerun-job", type=Path, help="the rerun job's Harbor job directory")
    parser.add_argument("--smoke-job", type=Path, required=True, help="the smoke job directory")
    parser.add_argument(
        "--oracle-record", type=Path, required=True, help="the oracle.json of the same dataset"
    )
    parser.add_argument(
        "--dataset-record", type=Path, required=True, help="the dataset's committed record"
    )
    parser.add_argument(
        "--artifact-dir", type=Path, required=True, help="the directory build:artifact wrote"
    )
    parser.add_argument(
        "--isolation-record",
        type=Path,
        help="the artifact's committed Isolation Record: the passing isolation test runs",
    )
    parser.add_argument(
        "--waive-isolation",
        metavar="REASON",
        help=(
            "record a job whose backend the Isolation Record does not clear, stating why; the "
            "record names the waiver and does not count under ADR 0005 §9 criterion 5"
        ),
    )
    parser.add_argument(
        "--waive-release-tag",
        metavar="REASON",
        help=(
            "record the dataset release commit the record names without resolving its tag, "
            "stating why; for a source repository that publishes no tag"
        ),
    )
    parser.add_argument(
        "--waive-timeout-override",
        metavar="REASON",
        help=(
            "record a job that raised its task timeouts, stating why; ADR 0005 §7 forbids a "
            "timeout override in the MVP's recorded job"
        ),
    )
    parser.add_argument(
        "--archive-part",
        type=Path,
        action="append",
        default=[],
        help="a part of the published archive, hashed into the manifest; repeat for each part",
    )
    parser.add_argument(
        "--scan-review",
        type=Path,
        help="the reviewed explanations of [REDACTED] and prefix matches",
    )
    parser.add_argument(
        "--credential",
        action="append",
        default=[],
        metavar="NAME",
        help="an extra environment variable whose value the scan searches for; repeat as needed",
    )
    parser.add_argument("--output-dir", type=Path, required=True, help="where to write the record")
    parser.add_argument("--uv-lock", type=Path, default=DEFAULT_UV_LOCK, help="the uv.lock file")
    args = parser.parse_args(argv)
    for flag, reason in (
        ("--waive-isolation", args.waive_isolation),
        ("--waive-release-tag", args.waive_release_tag),
        ("--waive-timeout-override", args.waive_timeout_override),
    ):
        if reason is not None and reason.strip() == "":
            print(f"error: {flag} needs a non-empty reason", file=sys.stderr)
            return 2
    if args.isolation_record is None and args.waive_isolation is None:
        print(
            "error: --isolation-record is required unless --waive-isolation states why this "
            "record does not show ADR 0005 §7's credential isolation precondition",
            file=sys.stderr,
        )
        return 2
    host = dict(os.environ if environment is None else environment)

    try:
        dataset = read_dataset_record(args.dataset_record)
        artifact = load_manifest(args.artifact_dir)
        pins = read_locked_pins(args.uv_lock)
        oracle = read_oracle_record(args.oracle_record)
        isolation_record = (
            json.loads(args.isolation_record.read_text(encoding="utf-8"))
            if args.isolation_record is not None
            else None
        )
    except (DatasetRecordError, ArtifactManifestError, OracleJobError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read the Isolation Record {args.isolation_record}: {exc}", file=sys.stderr)
        return 2
    if args.isolation_record is not None and not isinstance(isolation_record, dict):
        print(
            f"error: the Isolation Record {args.isolation_record} is not a JSON object",
            file=sys.stderr,
        )
        return 2
    try:
        recorded = read_job(args.job_dir)
        rerun = read_job(args.rerun_job) if args.rerun_job is not None else None
        smoke = read_job(args.smoke_job)
    except OracleJobError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except RecordError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    try:
        release_commit = (
            dataset.release_commit
            if args.waive_release_tag is not None
            else resolve_release_commit(dataset.source_repository, dataset.release_tag, run)
        )
        archive_parts = hash_archive_parts(args.archive_part)
    except (OracleJobError, RecordError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    inputs = RecordInputs(
        recorded=recorded,
        rerun=rerun,
        smoke=smoke,
        oracle=oracle,
        dataset=dataset,
        artifact=artifact,
        pins=pins,
        release_commit=release_commit,
        archive_parts=archive_parts,
        isolation_record=isolation_record,
        isolation_waiver=args.waive_isolation,
        release_tag_waiver=args.waive_release_tag,
        timeout_waiver=args.waive_timeout_override,
    )
    try:
        problems = protocol_problems(inputs)
    except RecordError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if problems:
        print("The job does not meet ADR 0005 §7. Nothing is written.", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1

    names = scan_credential_names(recorded, rerun, smoke, args.credential)
    roots = [recorded.directory, *([rerun.directory] if rerun is not None else [])]
    try:
        credentials = read_credentials(names, host)
        review = read_review(args.scan_review) if args.scan_review is not None else {}
        scan = scan_roots(roots, credentials, review)
    except SecretScanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if not scan.passed:
        print(report_text(scan), file=sys.stderr)
        print("The secret scan did not pass. Nothing is written.", file=sys.stderr)
        return 1

    try:
        data = build_record_data(inputs, scan)
        manifest = manifest_data(data)
        report = build_report(data)
    except RecordError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    leaks = credential_leak_problems(
        json.dumps(manifest, indent=2, allow_nan=False), report, credentials
    )
    if leaks:
        print("The record would hold a credential value. Nothing is written.", file=sys.stderr)
        for problem in leaks:
            print(f"- {problem}", file=sys.stderr)
        return 1
    try:
        write_record_files(args.output_dir, manifest, report)
    except RecordError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(summary_text(data))
    print(f"Wrote {args.output_dir / MANIFEST_FILE}")
    print(f"Wrote {args.output_dir / REPORT_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
