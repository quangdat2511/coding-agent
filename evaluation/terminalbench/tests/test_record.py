"""The record tooling of ADR 0005 §8: the secret scan, manifest.json and report.md.

Most tests write a small synthetic job directory in the shape Harbor 0.23.0 writes, so a test can
write a shape that Harbor's models refuse. The dataset is made up and its record is a Markdown table
in the shape of ADR 0008 §4, because ADR 0008 §5 forbids a test to hardcode a dataset name, version
or task count. The tests use the adapter's own run-file fixtures from tests/support.py, which mirror
packages/coding-agent/src/run-files.ts.
"""

import contextlib
import hashlib
import io
import json
import shutil
import tempfile
import tomllib
import unittest
from datetime import datetime
from pathlib import Path
from typing import Any
from unittest import mock

from harbor.metrics.mean import Mean
from harbor.models.job.config import DatasetConfig, JobConfig
from harbor.models.trial.config import AgentConfig, EnvironmentConfig

from coding_agent_terminalbench import record as record_module
from coding_agent_terminalbench.record import (
    ADAPTER_IMPORT_PATH,
    GITHUB_RELEASE_MAX_ASSETS,
    GITHUB_RELEASE_PART_LIMIT_BYTES,
    ArchivePart,
    RecordError,
    archive_problems,
    format_reward,
    harbor_mean,
    read_job,
)
from coding_agent_terminalbench.harbor_job import PHASES, interrupted_phase
from tests.support import (
    COMMIT as ARTIFACT_COMMIT,
    PROVIDER_KEY,
    agent_result,
    manifest_data,
    result_record_data,
    run_record_data,
    dataset_record_markdown,
    write_artifact,
    write_manifest,
    write_run_files,
)

DATASET_IDENTIFIER = "example-org/example-tasks@1.2.0"
DATASET_NAME = "example-org/example-tasks"
SOURCE_REPOSITORY = "https://example.com/example-org/example-tasks"
RELEASE_TAG = "v1.2.0"
RELEASE_COMMIT = "c" * 40
CONTENT_HASH = "sha256:" + "a" * 64
PROVIDER = "opencode"
MODEL = "deepseek-v4.1-flash"
MODEL_NAME = PROVIDER + "/" + MODEL
KEY_VARIABLE = "OPENCODE_API_KEY"
ARTIFACT_VERSION = "0.0.1"

TASKS = (
    "example-org/alpha",
    "example-org/bravo",
    "example-org/charlie",
    "example-org/delta",
)
SMOKE_TASKS = ("example-org/alpha", "example-org/bravo", "example-org/charlie")
INSTALLED_EXECUTABLE = "coding-agent-linux-x64"
UV_LOCK = Path(__file__).resolve().parent.parent / "uv.lock"
PROFILE_LIMITS = {
    "maxModelTurns": 250,
    "maxToolCalls": 1_000,
    "maxDurationMs": 3_600_000,
    "maxConsecutiveRecoverableFailures": 10,
    "cancellationGraceMs": 5_000,
}
JOB_STARTED = "2026-11-20T01:00:00Z"
JOB_FINISHED = "2026-11-20T02:00:00Z"
DEFAULT = object()

# Harbor finishes every started phase's timing in a finally block, so a failed phase has both
# times and the exception's occurred_at says which phase it was.
PHASE_WINDOWS = {
    "environment_setup": ("2026-11-20T01:00:00Z", "2026-11-20T01:00:10Z"),
    "agent_setup": ("2026-11-20T01:00:10Z", "2026-11-20T01:00:20Z"),
    "agent_execution": ("2026-11-20T01:00:20Z", "2026-11-20T01:02:20Z"),
    "verifier": ("2026-11-20T01:02:20Z", "2026-11-20T01:03:20Z"),
}
EXCEPTION_AT = {
    "environment_setup": "2026-11-20T01:00:05Z",
    "agent_setup": "2026-11-20T01:00:15Z",
    "agent_execution": "2026-11-20T01:01:20Z",
    "verifier": "2026-11-20T01:02:50Z",
}


def digest(task: str) -> str:
    return "sha256:" + hashlib.sha256(task.encode()).hexdigest()


def short_name(task: str) -> str:
    return task.split("/")[-1]


def trial_spec(**overrides: Any) -> dict[str, Any]:
    """One trial of the synthetic job, with the outcome a test names."""
    spec: dict[str, Any] = {
        "reward": {"reward": 1},
        "exception": None,
        # The phase the trial failed in, and the exception time that names it.
        "failure_phase": None,
        "exception_at": None,
        "failure": None,
        "exit_code": 0,
        "no_run": False,
        "no_agent_context": False,
        "verifier_environment_mode": "separate",
        "multi_step": False,
        "model_turns": 4,
        "tool_calls": 3,
        "profile": "terminalbench",
        "approval_policy": "auto-approve",
        "limits": PROFILE_LIMITS,
    }
    spec.update(overrides)
    return spec


HEALTHY_SPECS: dict[str, dict[str, Any]] = {
    "example-org/alpha": trial_spec(),
    "example-org/bravo": trial_spec(reward={"reward": 0}),
    "example-org/charlie": trial_spec(),
    "example-org/delta": trial_spec(
        reward=None,
        exception="EnvironmentStartTimeoutError",
        failure_phase="environment_setup",
        no_run=True,
        no_agent_context=True,
    ),
}
RERUN_SPECS: dict[str, dict[str, Any]] = {"example-org/delta": trial_spec()}
SMOKE_SPECS: dict[str, dict[str, Any]] = {task: trial_spec() for task in SMOKE_TASKS}


def dataset_record_text(**overrides: str | None) -> str:
    """A dataset record in the two-column table shape of ADR 0008 §4."""
    rows: dict[str, str] = {
        "Dataset identifier": "\x60" + DATASET_IDENTIFIER + "\x60",
        "Source repository": "\x60" + SOURCE_REPOSITORY + "\x60",
        "Release tag": "\x60" + RELEASE_TAG + "\x60",
        "Release commit": "\x60" + RELEASE_COMMIT + "\x60",
        "Task count": "derived from the job's resolved task list",
        "Environment": "a Dockerfile per task",
        "Single step": "every task",
        "Verifier environment": "separate, every task",
        "Per-task agent timeout": "28,800 s",
        "Smoke tasks": ", ".join("\x60" + short_name(task) + "\x60" for task in SMOKE_TASKS),
        "Tasks with declared MCP servers": "\x60" + short_name(TASKS[0]) + "\x60",
        "Tasks with a declared skills directory": "\x60" + short_name(TASKS[1]) + "\x60",
    }
    for label, value in overrides.items():
        if value is None:
            rows.pop(label, None)
        else:
            rows[label] = value
    return dataset_record_markdown(rows)


def write_dataset_record_file(path: Path, **overrides: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dataset_record_text(**overrides), encoding="utf-8")


def git_tag_lines(commit: str = RELEASE_COMMIT) -> str:
    ref = f"refs/tags/{RELEASE_TAG}"
    return f"{'d' * 40}\t{ref}\n{commit}\t{ref}^{{}}\n"


def annotated_tag(args: Any) -> str:
    return git_tag_lines()


class RecordTestCase(unittest.TestCase):
    """A repository root with an artifact, a dataset record, an oracle record and job paths."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.artifact_dir = self.root / "artifact"
        artifact_data = write_artifact(self.artifact_dir)
        self.artifact_hashes = {
            executable["file"]: executable["sha256"] for executable in artifact_data["executables"]
        }
        self.dataset_path = self.root / "datasets" / "example-tasks.md"
        write_dataset_record_file(self.dataset_path)
        self.oracle_path = self.root / "runs" / "oracle.json"
        self.write_oracle()
        self.jobs = self.root / "jobs"
        self.recorded = self.jobs / "recorded-job"
        self.rerun = self.jobs / "recorded-job-rerun"
        self.smoke = self.jobs / "smoke-job"
        self.archive = self.root / "archive" / "recorded-job.tar.zst.part-aa"
        self.archive.parent.mkdir(parents=True, exist_ok=True)
        self.archive.write_bytes(b"synthetic archive part")
        self.output = self.root / "runs" / "recorded-job"
        self.isolation_path = self.root / "isolation" / f"{ARTIFACT_COMMIT}.json"
        self.write_isolation_record()

    def write_isolation_record(self, backends: tuple[str, ...] = ("modal",)) -> None:
        """The Isolation Record of ADR 0005 §7 item 3: a root and a non-root run per backend.

        Written by hand, not by `isolation_record`, so that the record tooling is checked against
        the file's shape and not against its own writer."""
        runs = [
            {
                "date": "2026-11-22",
                "result": {
                    "passed": True,
                    "failures": [],
                    "codingAgent": {"version": ARTIFACT_VERSION, "commit": ARTIFACT_COMMIT},
                    "executableSha256": self.artifact_hashes[INSTALLED_EXECUTABLE],
                    "dataset": DATASET_IDENTIFIER,
                    "task": "example-org/alpha",
                    "backend": backend,
                    "user": {"uid": uid, "name": "root" if uid == 0 else "agent"},
                },
            }
            for backend in backends
            for uid in (0, 1000)
        ]
        document = {
            "schemaVersion": 1,
            "codingAgent": {"version": ARTIFACT_VERSION, "commit": ARTIFACT_COMMIT},
            "adrAmendment": "ADR 0001 §7, the CDA-29 amendment of 2026-09-13",
            "runs": runs,
        }
        self.isolation_path.parent.mkdir(parents=True, exist_ok=True)
        self.isolation_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

    def write_oracle(self, **overrides: Any) -> None:
        data: dict[str, Any] = {
            "schemaVersion": 1,
            "job": {"name": "oracle-example"},
            "dataset": {"identifier": DATASET_IDENTIFIER, "contentHash": CONTENT_HASH},
            "harnessFlakyTasks": [
                {"name": TASKS[1], "reward": 0, "exceptionType": None},
            ],
        }
        data.update(overrides)
        self.oracle_path.parent.mkdir(parents=True, exist_ok=True)
        self.oracle_path.write_text(json.dumps(data), encoding="utf-8")

    # The synthetic Harbor job directories.

    def write_job(
        self,
        job_dir: Path,
        *,
        name: str,
        tasks: tuple[str, ...] = TASKS,
        specs: dict[str, dict[str, Any]] | None = None,
        filtered: tuple[str, ...] | None = None,
        environment: str = "modal",
        agents: list[dict[str, Any]] | None = None,
        datasets: list[dict[str, Any]] | None = None,
        environment_config: dict[str, Any] | None = None,
        extra_config: dict[str, Any] | None = None,
        model_name: str = MODEL_NAME,
        env_value: str | None = None,
        jobs_dir: str | None = None,
        artifact_hashes: dict[str, str] | None = None,
        n_attempts: int | None = None,
        retry: int | None = None,
        harbor: str = "0.23.0",
        result_extra: dict[str, Any] | None = None,
        started: str | None = JOB_STARTED,
        finished: str | None = JOB_FINISHED,
    ) -> None:
        if job_dir.exists():
            shutil.rmtree(job_dir)
        job_dir.mkdir(parents=True)
        specs = specs if specs is not None else HEALTHY_SPECS
        hashes = artifact_hashes if artifact_hashes is not None else self.artifact_hashes
        customized = (
            agents is not None
            or datasets is not None
            or environment_config is not None
            or extra_config is not None
            or n_attempts is not None
            or retry is not None
            or env_value is not None
        )
        if customized:
            # A shape Harbor's models refuse, for the checks that must refuse it.
            if agents is None:
                agents = [
                    {
                        "import_path": ADAPTER_IMPORT_PATH,
                        "model_name": model_name,
                        "env": {
                            KEY_VARIABLE: env_value
                            or record_module.provider_env_template(KEY_VARIABLE)
                        },
                        "kwargs": {"artifact_dir": "dist/artifact"},
                    }
                ]
            if datasets is None:
                datasets = [{"name": DATASET_NAME, "ref": CONTENT_HASH}]
            if filtered is not None:
                datasets = [dict(dataset, task_names=list(filtered)) for dataset in datasets]
            config: dict[str, Any] = {
                "job_name": name,
                "jobs_dir": jobs_dir if jobs_dir is not None else self.jobs.as_posix(),
                "n_concurrent_trials": 8,
                "environment": environment_config or {"type": environment},
                "agents": agents,
                "datasets": datasets,
            }
            if n_attempts is not None:
                config["n_attempts"] = n_attempts
            if retry is not None:
                config["retry"] = {"max_retries": retry}
            config.update(extra_config or {})
        else:
            # The shape Harbor 0.23.0 writes, through Harbor's own JobConfig and
            # exclude_defaults, so the fixture keeps the fields Harbor omits at their defaults.
            config = self.harbor_config(
                name=name,
                environment=environment,
                filtered=filtered,
                jobs_dir=jobs_dir,
                model_name=model_name,
            )
        (job_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
        (job_dir / "lock.json").write_text(
            json.dumps(
                {
                    "schema_version": 3,
                    "harbor": {"version": harbor, "git_commit_hash": None},
                    "n_concurrent_trials": 8,
                    "retry": {"max_retries": retry if retry is not None else 0},
                    "trials": [
                        {"task": {"name": task, "type": "package", "digest": digest(task)}}
                        for task in tasks
                    ],
                }
            ),
            encoding="utf-8",
        )
        result: dict[str, Any] = {
            "id": "6f1c2a52-6b8e-4b5e-9a35-0c64d1f3f0aa",
            "started_at": started,
            "finished_at": finished,
            "n_total_trials": len(tasks),
            "stats": {},
        }
        result.update(result_extra or {})
        (job_dir / "result.json").write_text(json.dumps(result), encoding="utf-8")
        for index, task in enumerate(tasks):
            self.write_trial(job_dir, index, task, specs.get(task, trial_spec()), hashes)

    def harbor_config(
        self,
        *,
        name: str,
        environment: str,
        filtered: tuple[str, ...] | None,
        jobs_dir: str | None,
        model_name: str,
    ) -> dict[str, Any]:
        """The config.json that Harbor 0.23.0 writes for the command, through JobConfig."""
        agent = AgentConfig(
            import_path=ADAPTER_IMPORT_PATH,
            model_name=model_name,
            env={KEY_VARIABLE: record_module.provider_env_template(KEY_VARIABLE)},
            kwargs={"artifact_dir": "dist/artifact"},
        )
        dataset = DatasetConfig(
            name=DATASET_NAME,
            ref=CONTENT_HASH,
            task_names=list(filtered) if filtered is not None else None,
        )
        config = JobConfig(
            job_name=name,
            jobs_dir=Path(jobs_dir if jobs_dir is not None else self.jobs.as_posix()),
            n_concurrent_trials=8,
            environment=EnvironmentConfig(type=environment),
            agents=[agent],
            datasets=[dataset],
        )
        return json.loads(config.model_dump_json(exclude_defaults=True))

    def write_trial(
        self,
        job_dir: Path,
        index: int,
        task: str,
        spec: dict[str, Any],
        hashes: dict[str, str],
    ) -> None:
        trial_dir = job_dir / f"{short_name(task)}__trial{index}"
        trial_dir.mkdir()
        timings = self.timings(spec["failure_phase"])
        exception = spec["exception"]
        exception_at = spec["exception_at"] or EXCEPTION_AT.get(spec["failure_phase"] or "")
        result: dict[str, Any] = {
            "task_name": short_name(task),
            "trial_name": trial_dir.name,
            "verifier_result": None if spec["reward"] is None else {"rewards": spec["reward"]},
            "exception_info": (
                None
                if exception is None
                else {
                    "exception_type": exception,
                    "exception_message": "the trial stopped",
                    "exception_traceback": "",
                    "occurred_at": exception_at or JOB_STARTED,
                }
            ),
            "verifier_environment_mode": spec["verifier_environment_mode"],
            "step_results": [{"step_name": "step-1"}] if spec["multi_step"] else None,
            **timings,
        }
        if not spec["no_agent_context"]:
            result["agent_result"] = {
                "n_input_tokens": 2_700,
                "n_cache_tokens": 1_000,
                "n_output_tokens": 80,
                "metadata": {
                    "model_turns": spec["model_turns"],
                    "tool_calls": spec["tool_calls"],
                    "profile": spec["profile"],
                    "artifact_sha256": dict(hashes),
                    "installed_executable": INSTALLED_EXECUTABLE,
                    "truncated": False,
                },
            }
        (trial_dir / "result.json").write_text(json.dumps(result), encoding="utf-8")
        (trial_dir / "lock.json").write_text(
            json.dumps({"task": {"name": task, "type": "package", "digest": digest(task)}}),
            encoding="utf-8",
        )
        if not spec["no_run"]:
            self.write_run_files(trial_dir, spec)

    def timings(self, failure_phase: str | None) -> dict[str, Any]:
        """The phase timings: every phase up to and including the failed one, which ran."""
        timings: dict[str, Any] = {}
        for phase in PHASES:
            started, finished = PHASE_WINDOWS[phase]
            timings[phase] = {"started_at": started, "finished_at": finished}
            if phase == failure_phase:
                break
        return timings

    def write_run_files(self, trial_dir: Path, spec: dict[str, Any]) -> None:
        record = run_record_data(
            provider=PROVIDER,
            model=MODEL,
            profile=spec["profile"],
            approvalPolicy=spec["approval_policy"],
            limits=dict(spec["limits"]),
        )
        failure = spec["failure"]
        if failure is None:
            result = result_record_data(agent_result())
        else:
            result = result_record_data(
                agent_result(
                    drop=("verification",),
                    outcome="failed",
                    failure=failure,
                    finalMessage=None,
                ),
                exit_code=spec["exit_code"],
            )
        write_run_files(
            trial_dir / "agent" / "coding-agent", record=record, log=None, result=result
        )

    def write_recorded(self, **overrides: Any) -> None:
        overrides.setdefault("name", "recorded-job")
        overrides.setdefault("specs", HEALTHY_SPECS)
        self.write_job(self.recorded, **overrides)

    def write_smoke(self, **overrides: Any) -> None:
        overrides.setdefault("name", "smoke-job")
        overrides.setdefault("tasks", SMOKE_TASKS)
        overrides.setdefault("specs", SMOKE_SPECS)
        overrides.setdefault("filtered", SMOKE_TASKS)
        self.write_job(self.smoke, **overrides)

    def write_rerun(self, **overrides: Any) -> None:
        overrides.setdefault("name", "recorded-job-rerun")
        overrides.setdefault("tasks", ("example-org/delta",))
        overrides.setdefault("specs", RERUN_SPECS)
        overrides.setdefault("filtered", ("example-org/delta",))
        self.write_job(self.rerun, **overrides)

    def write_standard_jobs(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.write_rerun()

    # Running the record command.

    def scan_environment(self) -> dict[str, str]:
        return {KEY_VARIABLE: PROVIDER_KEY}

    def run_main(
        self,
        *,
        extra: tuple[str, ...] = (),
        rerun: Path | None | object = DEFAULT,
        environment: dict[str, str] | None = None,
        run: Any = None,
        dataset_record: Path | None = None,
        uv_lock: Path | None = None,
        output_dir: Path | None = None,
        artifact_dir: Path | None = None,
        isolation_record: Path | None = None,
    ) -> tuple[int, str, str]:
        argv = [
            str(self.recorded),
            "--isolation-record",
            str(isolation_record or self.isolation_path),
            "--smoke-job",
            str(self.smoke),
            "--oracle-record",
            str(self.oracle_path),
            "--dataset-record",
            str(dataset_record or self.dataset_path),
            "--artifact-dir",
            str(artifact_dir or self.artifact_dir),
            "--archive-part",
            str(self.archive),
            "--output-dir",
            str(output_dir or self.output),
            "--uv-lock",
            str(uv_lock or UV_LOCK),
        ]
        if rerun is DEFAULT:
            if self.rerun.exists():
                argv += ["--rerun-job", str(self.rerun)]
        elif rerun is not None:
            argv += ["--rerun-job", str(rerun)]
        argv.extend(extra)
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = record_module.main(
                argv,
                run=run or annotated_tag,
                environment=self.scan_environment() if environment is None else environment,
            )
        return code, stdout.getvalue(), stderr.getvalue()

    def manifest(self) -> dict[str, Any]:
        return json.loads((self.output / "manifest.json").read_text(encoding="utf-8"))

    def report(self) -> str:
        return (self.output / "report.md").read_text(encoding="utf-8")

    def record_ok(self) -> tuple[dict[str, Any], str, str]:
        self.write_standard_jobs()
        code, stdout, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        return self.manifest(), self.report(), stdout


class DefaultRecordTest(RecordTestCase):
    def test_writes_both_files_and_prints_a_summary(self) -> None:
        manifest, report, stdout = self.record_ok()
        self.assertTrue((self.output / "manifest.json").is_file())
        self.assertTrue((self.output / "report.md").is_file())
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertIn("Recorded job recorded-job", stdout)
        self.assertIn("valid: yes", stdout)
        self.assertIn("Secret scan:", stdout)
        self.assertIn("Wrote", stdout)
        self.assertIn("report.md", stdout)

    def test_manifest_records_the_pins_artifact_profile_and_model(self) -> None:
        manifest, _, _ = self.record_ok()
        with UV_LOCK.open("rb") as file:
            lock = tomllib.load(file)
        packages = {package["name"]: package["version"] for package in lock["package"]}
        self.assertEqual(manifest["pins"]["harbor"]["version"], packages["harbor"])
        self.assertEqual(
            manifest["pins"]["modalSdk"], {"version": packages["modal"], "source": "uv.lock"}
        )
        self.assertEqual(manifest["pins"]["python"]["minimum"], "3.12")
        self.assertEqual(
            manifest["artifact"],
            {
                "version": ARTIFACT_VERSION,
                "commit": ARTIFACT_COMMIT,
                "dirty": False,
                "bunVersion": "1.3.14",
                "executables": [
                    {
                        "file": "coding-agent-linux-x64",
                        "target": "bun-linux-x64-baseline",
                        "sha256": self.artifact_hashes["coding-agent-linux-x64"],
                    },
                    {
                        "file": "coding-agent-linux-arm64",
                        "target": "bun-linux-arm64",
                        "sha256": self.artifact_hashes["coding-agent-linux-arm64"],
                    },
                ],
                "installedExecutables": {INSTALLED_EXECUTABLE: 7},
            },
        )
        self.assertEqual(manifest["profile"], {"name": "terminalbench", "limits": PROFILE_LIMITS})
        self.assertEqual(
            manifest["model"],
            {
                "provider": PROVIDER,
                "model": MODEL,
                "sampling": {"maxOutputTokens": None, "temperature": None},
            },
        )
        self.assertEqual(manifest["environmentVariableNames"], [KEY_VARIABLE])
        self.assertNotIn(PROVIDER_KEY, json.dumps(manifest))

    def test_manifest_records_the_dataset_record_of_adr_0008(self) -> None:
        manifest, _, _ = self.record_ok()
        dataset = manifest["dataset"]
        self.assertEqual(dataset["identifier"], DATASET_IDENTIFIER)
        self.assertEqual(dataset["contentHash"], CONTENT_HASH)
        self.assertEqual(dataset["sourceRepository"], SOURCE_REPOSITORY)
        self.assertEqual(dataset["releaseTag"], RELEASE_TAG)
        self.assertEqual(dataset["releaseCommit"], RELEASE_COMMIT)
        self.assertIn("git ls-remote --tags", dataset["releaseCommitResolvedBy"])
        self.assertEqual(dataset["taskCount"], len(TASKS))
        self.assertEqual(
            dataset["taskList"],
            [{"name": task, "digest": digest(task)} for task in sorted(TASKS)],
        )
        self.assertEqual(dataset["smokeTasks"], [short_name(task) for task in SMOKE_TASKS])
        self.assertEqual(
            dataset["ignoredDeclarations"],
            {
                "mcpServers": [short_name(TASKS[0])],
                "skillsDirectories": [short_name(TASKS[1])],
            },
        )
        self.assertEqual(len(dataset["properties"]), 4)
        for entry in dataset["properties"]:
            self.assertTrue(entry["shown"])
            self.assertEqual(entry["problems"], [])
            self.assertIn(str(self.dataset_path), entry["source"])
        self.assertEqual(
            dataset["record"]["rows"]["Release commit"], "\x60" + RELEASE_COMMIT + "\x60"
        )

    def test_manifest_records_the_flags_job_times_and_related_job_names(self) -> None:
        manifest, _, _ = self.record_ok()
        self.assertEqual(
            manifest["flags"],
            {
                "agent": ADAPTER_IMPORT_PATH,
                "agentKwargs": {"artifact_dir": "dist/artifact"},
                "model": MODEL_NAME,
                "environment": "modal",
                "nAttempts": 1,
                "nConcurrentTrials": 8,
                "maxRetries": 0,
                "taskFilter": [],
                "jobsDir": str(self.jobs),
                "jobName": "recorded-job",
            },
        )
        self.assertEqual(
            manifest["job"],
            {
                "name": "recorded-job",
                "id": "6f1c2a52-6b8e-4b5e-9a35-0c64d1f3f0aa",
                "startedAt": JOB_STARTED,
                "finishedAt": JOB_FINISHED,
                "wallClockSeconds": 3600.0,
            },
        )
        self.assertEqual(
            manifest["relatedJobs"],
            {"oracle": "oracle-example", "smoke": "smoke-job", "rerun": "recorded-job-rerun"},
        )
        command = manifest["command"]
        self.assertIn("-d " + DATASET_IDENTIFIER, command)
        self.assertIn("--ae " + KEY_VARIABLE + "=", command)
        self.assertIn("-k 1", command)
        self.assertIn("-n 8", command)
        self.assertIn("-r 0", command)
        self.assertIn("--job-name recorded-job", command)

    def test_manifest_records_the_scan_and_the_archive_part_hashes(self) -> None:
        manifest, _, _ = self.record_ok()
        scan = manifest["secretScan"]
        self.assertEqual(scan["result"], "passed")
        self.assertGreater(scan["files"], 0)
        self.assertEqual(scan["patterns"]["credentialVariables"], [KEY_VARIABLE])
        self.assertIn("oc_sk_", scan["patterns"]["prefixes"])
        self.assertEqual(scan["patterns"]["redactedMarker"], "[REDACTED]")
        self.assertEqual(
            manifest["archive"]["parts"],
            [
                {
                    "file": self.archive.name,
                    "bytes": len(b"synthetic archive part"),
                    "sha256": hashlib.sha256(b"synthetic archive part").hexdigest(),
                }
            ],
        )

    def test_manifest_names_every_task_and_no_credential_value(self) -> None:
        manifest, report, _ = self.record_ok()
        texts = json.dumps(manifest) + report
        self.assertNotIn(PROVIDER_KEY, texts)
        self.assertEqual(manifest["dataset"]["taskCount"], len(TASKS))
        task_list = [entry["name"] for entry in manifest["dataset"]["taskList"]]
        for task in TASKS:
            self.assertIn(task, task_list)
        self.assertIn("Smoke tasks", manifest["dataset"]["record"]["rows"])

    def test_report_has_every_section_of_adr_0005_section_8(self) -> None:
        manifest, report, _ = self.record_ok()
        for heading in (
            "## Validity",
            "## Dataset",
            "## Result",
            "## Reward distribution",
            "## Per-task results",
            "## Agent Result against reward",
            "## Rerun-eligible trials",
            "## Harness-flaky tasks",
            "## Ignored MCP servers and skills",
        ):
            self.assertIn(heading, report)
        self.assertIn("Evaluation Profile: terminalbench", report)
        self.assertIn(DATASET_IDENTIFIER, report)
        self.assertIn(RELEASE_COMMIT, report)
        self.assertIn("no pass or fail threshold", report)
        self.assertIn("never pooled", report)
        self.assertIn("**Valid.**", report)
        self.assertIn("N is 4", report)
        self.assertIn("Mean reward: 0.75 over the 4 recorded outcomes", report)
        self.assertIn("recorded-job", report)

    def test_report_mean_matches_harbors_own_mean(self) -> None:
        manifest, report, _ = self.record_ok()
        rewards = [{"reward": 1}, {"reward": 0}, {"reward": 1}, {"reward": 1}]
        expected = Mean().compute(rewards)["mean"]
        self.assertEqual(harbor_mean(rewards), {"mean": expected})
        self.assertEqual(manifest["dataset"]["taskCount"], len(rewards))
        self.assertIn("Mean reward: " + format_reward(expected), report)

    def test_report_per_task_table_and_cross_tabulation(self) -> None:
        manifest, report, _ = self.record_ok()
        self.assertIn("| Task | Reward | Source |", report)
        for task in TASKS:
            self.assertIn(task, report)
        self.assertIn("| succeeded |", report)
        self.assertIn("## Agent Result against reward", report)
        self.assertIn("| Agent Result | 0 | 1 |", report)

    def test_report_lists_the_rerun_eligible_trial_and_its_rerun_outcome(self) -> None:
        manifest, report, _ = self.record_ok()
        self.assertIn("environment setup", report)
        self.assertIn("EnvironmentStartTimeoutError", report)
        rerun_section = report.split("## Rerun-eligible trials", 1)[1].split("## ", 1)[0]
        self.assertIn("example-org/delta", rerun_section)
        self.assertIn("no verifier reward", rerun_section)
        self.assertIn("rerun", rerun_section)

    def test_report_lists_harness_flaky_tasks_and_ignored_declarations(self) -> None:
        manifest, report, _ = self.record_ok()
        flaky_section = report.split("## Harness-flaky tasks", 1)[1].split("## ", 1)[0]
        self.assertIn("example-org/bravo", flaky_section)
        ignored_section = report.split("## Ignored MCP servers and skills", 1)[1]
        self.assertIn(short_name(TASKS[0]), ignored_section)
        self.assertIn("MCP", ignored_section)
        self.assertIn(short_name(TASKS[1]), ignored_section)
        self.assertIn("skills", ignored_section)

    def test_a_config_with_harbors_default_jobs_dir_is_read(self) -> None:
        # Harbor writes config.json with exclude_defaults, so -o jobs leaves the field out.
        self.write_recorded(jobs_dir="jobs")
        self.write_smoke()
        self.write_rerun()
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        manifest = self.manifest()
        self.assertEqual(manifest["flags"]["jobsDir"], "jobs")
        self.assertIn("-o jobs", manifest["command"])
        self.assertNotIn("jobs_dir", json.loads((self.recorded / "config.json").read_text()))

    def test_a_smoke_job_may_keep_harbors_default_environment(self) -> None:
        self.write_recorded()
        self.write_smoke(environment="docker")
        self.write_rerun()
        smoke_config = json.loads((self.smoke / "config.json").read_text(encoding="utf-8"))
        self.assertNotIn("environment", smoke_config)
        recorded_config = json.loads((self.recorded / "config.json").read_text())
        self.assertEqual(recorded_config["environment"], {"type": "modal"})
        # The smoke job ran on Docker, so the isolation test must have passed there too.
        self.write_isolation_record(backends=("modal", "docker"))
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        self.assertEqual(self.manifest()["flags"]["environment"], "modal")

    def test_the_smoke_job_filter_is_read_from_the_dataset(self) -> None:
        self.write_standard_jobs()
        smoke_config = json.loads((self.smoke / "config.json").read_text(encoding="utf-8"))
        self.assertNotIn("tasks", smoke_config)
        self.assertEqual(
            smoke_config["datasets"][0]["task_names"], list(SMOKE_TASKS)
        )
        self.assertEqual(read_job(self.smoke).task_filter(), SMOKE_TASKS)
        self.assertNotIn("task_names", read_job(self.recorded).dataset)

    def test_the_task_name_and_count_come_from_the_job_not_a_literal(self) -> None:
        manifest, report, _ = self.record_ok()
        self.assertEqual(manifest["dataset"]["taskCount"], len(TASKS))
        # The record's Task count row is prose and must not become N.
        self.assertEqual(len(manifest["dataset"]["taskList"]), len(TASKS))
        self.assertIn("N is " + str(len(TASKS)), report)


class IsolationRecordTest(RecordTestCase):
    """ADR 0005 §7 item 3: no job record without a passing isolation test for the artifact."""

    def test_the_manifest_holds_the_isolation_record(self) -> None:
        manifest, _, _ = self.record_ok()

        self.assertEqual(
            manifest["credentialIsolation"], json.loads(self.isolation_path.read_text("utf-8"))
        )

    def test_a_record_without_a_run_on_the_jobs_backend_writes_nothing(self) -> None:
        self.write_isolation_record(backends=("docker",))
        self.write_standard_jobs()

        code, _, stderr = self.run_main()

        self.assertEqual(code, 1)
        self.assertIn("no passing run on modal", stderr)
        self.assertFalse((self.output / "manifest.json").exists())

    def test_a_smoke_job_on_docker_needs_a_passing_docker_run_too(self) -> None:
        # Written after the behavior existed, so it passed at once: a guard, not a red step.
        self.write_recorded()
        self.write_smoke(environment="docker")
        self.write_rerun()

        code, _, stderr = self.run_main()

        self.assertEqual(code, 1)
        self.assertIn("no passing run on docker", stderr)
        self.assertNotIn("no passing run on modal", stderr)
        self.assertFalse((self.output / "manifest.json").exists())

    def test_an_isolation_record_that_is_not_a_json_object_writes_nothing(self) -> None:
        # A record can be edited by hand (PR #114 review).
        self.write_standard_jobs()
        for text in ('"x"', "[]", "[1, 2]"):
            with self.subTest(record=text):
                self.isolation_path.write_text(text, encoding="utf-8")

                code, _, stderr = self.run_main()

                self.assertEqual(code, 2)
                self.assertIn("not a JSON object", stderr)
                self.assertFalse((self.output / "manifest.json").exists())

    def test_a_missing_isolation_record_file_writes_nothing(self) -> None:
        self.write_standard_jobs()

        code, _, stderr = self.run_main(isolation_record=self.root / "isolation" / "absent.json")

        self.assertEqual(code, 2)
        self.assertIn("absent.json", stderr)
        self.assertFalse((self.output / "manifest.json").exists())


class MeanTest(unittest.TestCase):
    """The mean of ADR 0005 §8 must be what Harbor's own Mean metric computes."""

    def test_matches_harbor_for_a_complete_job(self) -> None:
        rewards = [{"reward": 1}, {"reward": 0}, {"reward": 0.5}]
        self.assertEqual(harbor_mean(rewards), Mean().compute(rewards))

    def test_matches_harbor_when_a_trial_has_no_reward(self) -> None:
        rewards: list[dict[str, float] | None] = [{"reward": 1}, None, {"reward": 0.5}]
        self.assertEqual(harbor_mean(rewards), Mean().compute(rewards))

    def test_matches_harbor_for_several_reward_keys(self) -> None:
        rewards: list[dict[str, float] | None] = [
            {"reward": 1, "partial": 0.25},
            None,
            {"reward": 0, "partial": 1},
        ]
        self.assertEqual(harbor_mean(rewards), Mean().compute(rewards))

    def test_no_outcome_has_no_mean(self) -> None:
        self.assertEqual(harbor_mean([]), {})


class RerunEligibilityTest(RecordTestCase):
    """The ADR 0005 §7 rerun rule, including its HTTP status condition."""

    def trial(self, spec: dict[str, Any]) -> Any:
        self.write_recorded(specs={**HEALTHY_SPECS, TASKS[1]: spec})
        job = read_job(self.recorded)
        return {trial.task: trial for trial in job.trials}[TASKS[1]]

    def test_a_trial_without_a_reward_is_eligible_and_names_its_phase(self) -> None:
        trial = self.trial(
            trial_spec(
                reward=None,
                exception="EnvironmentStartTimeoutError",
                failure_phase="environment_setup",
                no_run=True,
                no_agent_context=True,
            )
        )
        self.assertTrue(trial.rerun_eligible)
        self.assertIn("no verifier reward", trial.rerun_reason or "")
        self.assertIn("EnvironmentStartTimeoutError", trial.rerun_reason or "")
        self.assertIn("environment setup", trial.rerun_reason or "")

    def test_the_interrupted_phase_comes_from_harbors_timings(self) -> None:
        for phase, expected in (
            ("environment_setup", "environment setup"),
            ("agent_setup", "agent setup"),
            ("agent_execution", "agent execution"),
            ("verifier", "the verifier"),
        ):
            with self.subTest(phase=phase):
                trial = self.trial(
                    trial_spec(
                        reward=None,
                        exception="SomeError",
                        failure_phase=phase,
                        no_run=True,
                        no_agent_context=True,
                    )
                )
                self.assertIn("during " + expected, trial.rerun_reason or "")

    def test_the_exception_time_names_the_phase_when_every_phase_ran(self) -> None:
        # After an agent timeout Harbor still runs the verifier, so every phase has timings; the
        # exception's occurred_at is what says the agent phase failed.
        trial = self.trial(
            trial_spec(
                reward=None,
                exception="AgentTimeoutError",
                exception_at=EXCEPTION_AT["agent_execution"],
                no_run=True,
                no_agent_context=True,
            )
        )
        self.assertIn("during agent execution", trial.rerun_reason or "")

    def test_a_model_failure_with_a_rerun_status_is_eligible(self) -> None:
        for status in (401, 403, 429, 500, 503, 599):
            with self.subTest(status=status):
                trial = self.trial(
                    trial_spec(
                        reward={"reward": 0},
                        failure={
                            "code": "MODEL_FAILURE",
                            "message": "the provider failed",
                            "details": {
                                "phase": "request",
                                "reason": "error",
                                "httpStatus": status,
                            },
                        },
                        exit_code=1,
                    )
                )
                self.assertTrue(trial.rerun_eligible)
                self.assertIn("HTTP " + str(status), trial.rerun_reason or "")

    def test_a_model_failure_outside_the_rerun_statuses_is_not_eligible(self) -> None:
        trial = self.trial(
            trial_spec(
                reward={"reward": 0},
                failure={
                    "code": "MODEL_FAILURE",
                    "message": "the request was invalid",
                    "details": {"phase": "request", "reason": "error", "httpStatus": 400},
                },
                exit_code=1,
            )
        )
        self.assertFalse(trial.rerun_eligible)
        self.assertIsNone(trial.rerun_reason)

    def test_another_failure_code_is_not_eligible(self) -> None:
        trial = self.trial(
            trial_spec(
                reward={"reward": 0},
                failure={"code": "VERIFICATION_FAILED", "message": "the verifier said no"},
                exit_code=1,
            )
        )
        self.assertFalse(trial.rerun_eligible)

    def test_a_trial_with_a_reward_and_no_failure_is_not_eligible(self) -> None:
        self.assertFalse(self.trial(trial_spec()).rerun_eligible)


class InterruptedPhaseTest(unittest.TestCase):
    """ADR 0005 §8 reads the failed phase from Harbor's phase timings."""

    @staticmethod
    def phases(
        **overrides: tuple[str | None, str | None],
    ) -> dict[str, tuple[datetime | None, datetime | None]]:
        def at(value: str | None) -> datetime | None:
            return None if value is None else datetime.fromisoformat(value)

        windows: dict[str, tuple[str | None, str | None]] = {
            "environment_setup": ("2026-11-20T01:00:00+00:00", "2026-11-20T01:00:10+00:00"),
            "agent_setup": ("2026-11-20T01:00:10+00:00", "2026-11-20T01:00:20+00:00"),
            "agent_execution": ("2026-11-20T01:00:20+00:00", "2026-11-20T01:02:20+00:00"),
            "verifier": ("2026-11-20T01:02:20+00:00", "2026-11-20T01:03:20+00:00"),
        }
        windows.update(overrides)
        return {name: (at(start), at(finish)) for name, (start, finish) in windows.items()}

    def test_the_exception_time_names_the_phase_that_was_running(self) -> None:
        # Harbor finishes the timing of a failed phase in a finally block, so the window holds
        # the exception even though every earlier phase finished too.
        phases = self.phases(
            agent_setup=("2026-11-20T01:00:10+00:00", None),
            agent_execution=(None, None),
            verifier=(None, None),
        )
        occurred = datetime.fromisoformat("2026-11-20T01:00:15+00:00")
        self.assertEqual(interrupted_phase(phases, occurred), "agent_setup")

    def test_a_later_phase_does_not_hide_the_exception_time(self) -> None:
        occurred = datetime.fromisoformat("2026-11-20T01:01:20+00:00")
        self.assertEqual(interrupted_phase(self.phases(), occurred), "agent_execution")

    def test_the_last_started_phase_is_the_fallback_without_an_exception_time(self) -> None:
        phases = self.phases(verifier=(None, None))
        self.assertEqual(interrupted_phase(phases), "agent_execution")

    def test_no_started_phase_has_no_phase(self) -> None:
        phases = self.phases(
            environment_setup=(None, None),
            agent_setup=(None, None),
            agent_execution=(None, None),
            verifier=(None, None),
        )
        self.assertIsNone(interrupted_phase(phases))


class MissingRewardValidityTest(RecordTestCase):
    def test_a_missing_reward_without_a_rerun_makes_the_job_invalid(self) -> None:
        self.write_recorded()
        self.write_smoke()
        code, stdout, stderr = self.run_main(rerun=None)
        self.assertEqual(code, 0, stderr)
        report = self.report()
        self.assertIn("**Not valid.**", report)
        self.assertIn("No headline reward", report)
        self.assertIn("example-org/delta", report)
        self.assertIn("did not run it", report)
        # A trial without a reward counts as 0, as Harbor's mean counts it.
        self.assertIn("the mean over the 4 recorded outcomes is 0.5", report)
        manifest = self.manifest()
        self.assertIsNone(manifest["relatedJobs"]["rerun"])
        self.assertEqual(manifest["dataset"]["taskCount"], len(TASKS))
        self.assertIn("valid: no", stdout)

    def test_the_rerun_jobs_absent_trial_is_the_reported_problem(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.run_main(rerun=None)
        report = self.report()
        problems = report.split("**Not valid.**", 1)[1]
        self.assertIn("has no completed trial", problems)
        # The row of a task with no recorded outcome still has every column.
        header = next(line for line in report.splitlines() if line.startswith("| Task | Reward |"))
        row = next(
            line for line in report.splitlines() if line.startswith("| example-org/delta | no")
        )
        self.assertEqual(row.count("|"), header.count("|"))


class RerunJobTest(RecordTestCase):
    def test_a_rerun_job_with_another_name_is_refused(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.write_rerun(name="another-rerun")
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("-rerun", stderr)
        self.assertFalse(self.output.exists())

    def test_a_rerun_job_with_another_dataset_is_refused(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.write_rerun(datasets=[{"name": "example-org/other-tasks", "ref": CONTENT_HASH}])
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("dataset", stderr)

    def test_a_rerun_of_a_task_that_did_not_need_one_is_reported(self) -> None:
        self.write_recorded()
        self.write_smoke()
        tasks = (TASKS[0], "example-org/delta")
        self.write_rerun(
            tasks=tasks,
            specs={"example-org/alpha": trial_spec(), "example-org/delta": trial_spec()},
            filtered=tasks,
        )
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        report = self.report()
        self.assertIn("**Not valid.**", report)
        self.assertIn("did not select for a rerun", report)

    def test_a_rerun_eligible_task_without_a_rerun_trial_is_invalid(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.write_rerun(
            tasks=(TASKS[0],),
            specs={"example-org/alpha": trial_spec()},
            filtered=(TASKS[0],),
        )
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        report = self.report()
        self.assertIn("did not run it", report)

    def test_a_rerun_trial_that_is_rerun_eligible_again_makes_the_job_invalid(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.write_rerun(
            specs={
                "example-org/delta": trial_spec(
                    reward=None, exception="SomeError", no_run=True, no_agent_context=True
                )
            }
        )
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        report = self.report()
        self.assertIn("**Not valid.**", report)
        self.assertIn("a rerun trial is never rerun", report)

    def test_a_rerun_outcome_replaces_the_recorded_one(self) -> None:
        failure = {
            "code": "MODEL_FAILURE",
            "message": "rate limited",
            "details": {"phase": "request", "reason": "error", "httpStatus": 429},
        }
        self.write_recorded(
            specs={
                **HEALTHY_SPECS,
                "example-org/delta": trial_spec(reward={"reward": 0}, failure=failure, exit_code=1),
            }
        )
        self.write_smoke()
        self.write_rerun()
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        report = self.report()
        self.assertIn("HTTP 429", report)
        self.assertIn("Mean reward: 0.75", report)
        self.assertIn("| example-org/delta | 1 | rerun |", report)


class SecretScanTest(RecordTestCase):
    """ADR 0005 §8's scan: every file, file and offset, and credentials are never explainable."""

    def plant(self, job_dir: Path, name: str, text: str) -> Path:
        path = job_dir / name
        path.write_text(text, encoding="utf-8")
        return path

    def review_file(self, entries: list[dict[str, Any]]) -> Path:
        path = self.root / "review.json"
        path.write_text(json.dumps({"reviewed": entries}), encoding="utf-8")
        return path

    def test_a_planted_credential_fails_the_scan_and_names_the_file_and_offset(self) -> None:
        self.write_standard_jobs()
        text = "tool output: " + PROVIDER_KEY + "\n"
        self.plant(self.recorded, "events.log", text)
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("events.log", stderr)
        self.assertIn(str(len("tool output: ")), stderr)
        self.assertIn("credential", stderr)
        self.assertNotIn(PROVIDER_KEY, stderr)
        self.assertFalse(self.output.exists())

    def test_a_credential_in_the_rerun_job_fails_the_scan(self) -> None:
        self.write_standard_jobs()
        self.plant(self.rerun, "trial.log", PROVIDER_KEY)
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("recorded-job-rerun", stderr)

    def test_a_reviewed_redacted_match_passes_and_is_recorded(self) -> None:
        self.write_standard_jobs()
        text = "the tests print token=[REDACTED]\n"
        path = self.plant(self.recorded, "trial.log", text)
        review = self.review_file(
            [
                {
                    "file": path.as_posix(),
                    "offset": text.index("[REDACTED]"),
                    "reason": "the task itself writes this word, not a scrubbed credential",
                }
            ]
        )
        code, _, stderr = self.run_main(extra=("--scan-review", str(review)))
        self.assertEqual(code, 0, stderr)
        scan = self.manifest()["secretScan"]
        self.assertEqual(scan["result"], "passed")
        self.assertEqual(scan["unexplained"], 0)
        self.assertEqual(len(scan["explained"]), 1)
        self.assertIn("not a scrubbed credential", scan["explained"][0]["reason"])

    def test_an_unreviewed_redacted_match_fails(self) -> None:
        self.write_standard_jobs()
        self.plant(self.recorded, "trial.log", "token=[REDACTED]\n")
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("[REDACTED]", stderr)
        self.assertFalse(self.output.exists())

    def test_a_reviewed_key_prefix_match_passes(self) -> None:
        self.write_standard_jobs()
        text = "the task's example value starts with sk-ant-\n"
        path = self.plant(self.recorded, "logs.txt", text)
        review = self.review_file(
            [
                {
                    "file": path.as_posix(),
                    "offset": text.index("sk-ant-"),
                    "reason": "the task's own example prefix, not a credential",
                }
            ]
        )
        code, _, stderr = self.run_main(extra=("--scan-review", str(review)))
        self.assertEqual(code, 0, stderr)
        self.assertEqual(len(self.manifest()["secretScan"]["explained"]), 1)

    def test_an_unreviewed_key_prefix_match_fails(self) -> None:
        self.write_standard_jobs()
        self.plant(self.recorded, "logs.txt", "example sk-ant-abc\n")
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("sk-ant-", stderr)

    def test_a_credential_match_cannot_be_explained(self) -> None:
        self.write_standard_jobs()
        text = PROVIDER_KEY
        path = self.plant(self.recorded, "leak.log", text)
        review = self.review_file(
            [{"file": path.as_posix(), "offset": 0, "reason": "it was already revoked"}]
        )
        code, _, stderr = self.run_main(extra=("--scan-review", str(review)))
        self.assertEqual(code, 1)
        self.assertNotIn(PROVIDER_KEY, stderr)
        self.assertFalse(self.output.exists())

    def test_a_review_reason_that_holds_the_credential_value_is_refused(self) -> None:
        self.write_standard_jobs()
        text = "token=[REDACTED]\n"
        path = self.plant(self.recorded, "trial.log", text)
        review = self.review_file(
            [
                {
                    "file": path.as_posix(),
                    "offset": text.index("[REDACTED]"),
                    "reason": "the value was " + PROVIDER_KEY,
                }
            ]
        )
        code, _, stderr = self.run_main(extra=("--scan-review", str(review)))
        self.assertEqual(code, 1)
        self.assertIn("would hold a credential value", stderr)
        self.assertNotIn(PROVIDER_KEY, stderr)
        self.assertFalse(self.output.exists())

    def test_a_missing_provider_key_in_the_environment_is_an_error(self) -> None:
        self.write_standard_jobs()
        code, _, stderr = self.run_main(environment={})
        self.assertEqual(code, 2)
        self.assertIn(KEY_VARIABLE, stderr)
        self.assertFalse(self.output.exists())


class ConfigCheckTest(RecordTestCase):
    """The record refuses a job whose config.json is not the recorded-job command."""

    def refused(self, expected: str, **run_kwargs: Any) -> str:
        code, _, stderr = self.run_main(**run_kwargs)
        self.assertEqual(code, 1, stderr)
        self.assertIn(expected, stderr)
        self.assertFalse(self.output.exists())
        return stderr

    def test_two_attempts_per_task_are_refused(self) -> None:
        self.write_recorded(n_attempts=2)
        self.write_smoke()
        self.write_rerun()
        self.refused("-k 1")

    def test_a_harbor_retry_is_refused(self) -> None:
        self.write_recorded(retry=2)
        self.write_smoke()
        self.write_rerun()
        self.refused("-r 0")

    def test_a_task_filter_on_the_recorded_job_is_refused(self) -> None:
        self.write_recorded(filtered=TASKS)
        self.write_smoke()
        self.write_rerun()
        self.refused("task filter")

    def test_another_environment_is_refused(self) -> None:
        self.write_recorded(environment="docker")
        self.write_smoke()
        self.write_rerun()
        self.refused("modal")

    def test_another_agent_is_refused(self) -> None:
        self.write_recorded(
            agents=[
                {
                    "import_path": "example_agent:Agent",
                    "model_name": MODEL_NAME,
                    "env": {KEY_VARIABLE: record_module.provider_env_template(KEY_VARIABLE)},
                    "kwargs": {"artifact_dir": "dist/artifact"},
                }
            ]
        )
        self.write_smoke()
        self.write_rerun()
        self.refused(ADAPTER_IMPORT_PATH)

    def test_another_model_than_the_run_recorded_is_refused(self) -> None:
        self.write_recorded(model_name="openrouter/deepseek-v4.1-flash")
        self.write_smoke()
        self.write_rerun()
        self.refused("provider")

    def test_another_approval_policy_is_refused(self) -> None:
        self.write_recorded(
            specs={**HEALTHY_SPECS, TASKS[0]: trial_spec(approval_policy="ask")}
        )
        self.write_smoke()
        self.write_rerun()
        self.refused("auto-approve")

    def test_another_profile_is_refused(self) -> None:
        self.write_recorded(
            specs={**HEALTHY_SPECS, TASKS[0]: trial_spec(profile="default")}
        )
        self.write_smoke()
        self.write_rerun()
        self.refused("terminalbench")

    def test_two_datasets_are_refused(self) -> None:
        dataset = {"name": DATASET_NAME, "ref": CONTENT_HASH}
        self.write_recorded(datasets=[dataset, dataset])
        self.write_smoke()
        self.write_rerun()
        self.refused("exactly one dataset")

    def test_a_literal_credential_is_refused(self) -> None:
        self.write_recorded(env_value="sk-o****xyz")
        self.write_smoke()
        self.write_rerun()
        self.refused("--ae template")

    def test_an_extra_agent_variable_is_refused(self) -> None:
        self.write_recorded(
            agents=[
                {
                    "import_path": ADAPTER_IMPORT_PATH,
                    "model_name": MODEL_NAME,
                    "env": {
                        KEY_VARIABLE: record_module.provider_env_template(KEY_VARIABLE),
                        "EXTRA_TOKEN": "value",
                    },
                    "kwargs": {"artifact_dir": "dist/artifact"},
                }
            ]
        )
        self.write_smoke()
        self.write_rerun()
        self.refused("only the provider key")

    def test_an_unexpected_agent_kwarg_is_refused(self) -> None:
        self.write_recorded(
            agents=[
                {
                    "import_path": ADAPTER_IMPORT_PATH,
                    "model_name": MODEL_NAME,
                    "env": {KEY_VARIABLE: record_module.provider_env_template(KEY_VARIABLE)},
                    "kwargs": {"artifact_dir": "dist/artifact", "timeout": 60},
                }
            ]
        )
        self.write_smoke()
        self.write_rerun()
        self.refused("agent kwargs")

    def test_an_unexpected_config_field_is_refused(self) -> None:
        self.write_recorded(extra_config={"timeout_multiplier": 2.0})
        self.write_smoke()
        self.write_rerun()
        self.refused("timeout_multiplier")

    def test_another_harbor_version_is_refused(self) -> None:
        self.write_recorded(harbor="0.24.0")
        self.write_smoke()
        self.write_rerun()
        self.refused("uv.lock pins")

    def test_an_unfinished_job_is_refused(self) -> None:
        self.write_recorded(result_extra={"finished_at": None})
        self.write_smoke()
        self.write_rerun()
        self.refused("did not finish")

    def test_a_task_names_filter_that_is_not_a_list_is_refused(self) -> None:
        self.write_recorded(
            datasets=[
                {
                    "name": DATASET_NAME,
                    "ref": CONTENT_HASH,
                    "task_names": "example-org/alpha",
                }
            ]
        )
        self.write_smoke()
        self.write_rerun()
        self.refused("task_names")

    def test_a_rerun_run_with_other_session_limits_is_refused(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.write_rerun(
            specs={
                "example-org/delta": trial_spec(
                    limits={**PROFILE_LIMITS, "maxModelTurns": 10}
                )
            }
        )
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("SessionLimits", stderr)
        self.assertFalse(self.output.exists())

    def test_a_failed_write_keeps_a_record_that_was_already_there(self) -> None:
        self.write_standard_jobs()
        self.output.mkdir(parents=True)
        manifest_path = self.output / "manifest.json"
        report_path = self.output / "report.md"
        manifest_path.write_text("previous manifest", encoding="utf-8")
        report_path.write_text("previous report", encoding="utf-8")
        failure = RecordError("cannot write the record")
        with mock.patch.object(record_module, "write_text_file", side_effect=failure):
            code, _, stderr = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("cannot write the record", stderr)
        self.assertEqual(manifest_path.read_text(encoding="utf-8"), "previous manifest")
        self.assertEqual(report_path.read_text(encoding="utf-8"), "previous report")

    def test_a_missing_trial_directory_is_refused(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.write_rerun()
        shutil.rmtree(self.recorded / "alpha__trial0")
        self.refused("finished trials")

    def test_a_trial_directory_without_a_result_is_refused(self) -> None:
        self.write_recorded()
        self.write_smoke()
        self.write_rerun()
        (self.recorded / "echo__trial9").mkdir()
        self.refused("did not finish")

    def test_a_smoke_job_with_another_model_is_refused(self) -> None:
        self.write_recorded()
        self.write_smoke(model_name="opencode/another-model")
        self.write_rerun()
        self.refused("smoke job must use")

    def test_a_smoke_job_that_does_not_run_the_smoke_set_is_refused(self) -> None:
        self.write_recorded()
        self.write_smoke(tasks=TASKS, specs=HEALTHY_SPECS, filtered=TASKS)
        self.write_rerun()
        self.refused("smoke set")

    def test_an_oracle_record_of_another_dataset_is_refused(self) -> None:
        self.write_oracle(dataset={"identifier": "example-org/other@1.0.0"})
        self.write_standard_jobs()
        self.refused("oracle record describes")

    def test_an_oracle_record_of_another_pin_is_refused(self) -> None:
        self.write_oracle(
            dataset={
                "identifier": DATASET_IDENTIFIER,
                "contentHash": "sha256:" + "b" * 64,
            }
        )
        self.write_standard_jobs()
        self.refused("another pin")

    def test_an_oracle_record_without_a_content_hash_is_refused(self) -> None:
        self.write_oracle(dataset={"identifier": DATASET_IDENTIFIER})
        self.write_standard_jobs()
        self.refused("no dataset content hash")

    def test_a_release_commit_that_differs_from_the_record_is_refused(self) -> None:
        self.write_standard_jobs()
        self.refused(
            "resolves to",
            run=lambda _: git_tag_lines("e" * 40),
        )

    def test_a_dirty_artifact_is_refused(self) -> None:
        self.write_standard_jobs()
        data = manifest_data()
        data["dirty"] = True
        write_manifest(self.artifact_dir, data)
        self.refused("dirty working tree")

    def test_another_artifact_version_is_refused(self) -> None:
        self.write_standard_jobs()
        data = manifest_data()
        data["codingAgent"] = {"version": "9.9.9", "commit": ARTIFACT_COMMIT}
        write_manifest(self.artifact_dir, data)
        self.refused("artifact-manifest.json records")

    def test_an_artifact_hash_that_differs_from_the_trials_is_refused(self) -> None:
        self.write_recorded(
            artifact_hashes={
                "coding-agent-linux-x64": "f" * 64,
                "coding-agent-linux-arm64": "f" * 64,
            }
        )
        self.write_smoke()
        self.write_rerun()
        self.refused("artifact SHA-256")

    def test_a_multi_step_trial_makes_the_job_invalid(self) -> None:
        self.write_recorded(specs={**HEALTHY_SPECS, TASKS[0]: trial_spec(multi_step=True)})
        self.write_smoke()
        self.write_rerun()
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        report = self.report()
        self.assertIn("**Not valid.**", report)
        self.assertIn("single-step", report)

    def test_a_shared_verifier_environment_makes_the_job_invalid(self) -> None:
        self.write_recorded(
            specs={**HEALTHY_SPECS, TASKS[0]: trial_spec(verifier_environment_mode="shared")}
        )
        self.write_smoke()
        self.write_rerun()
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        self.assertIn("verifier environment mode", self.report())

    def test_a_timeout_below_the_profile_bound_makes_the_job_invalid(self) -> None:
        write_dataset_record_file(self.dataset_path, **{"Per-task agent timeout": "1,800 s"})
        self.write_recorded()
        self.write_smoke()
        self.write_rerun()
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        report = self.report()
        self.assertIn("**Not valid.**", report)
        self.assertIn("1800", report)

    def test_a_missing_evidence_row_makes_the_job_invalid(self) -> None:
        write_dataset_record_file(self.dataset_path, **{"Verifier environment": None})
        self.write_recorded()
        self.write_smoke()
        self.write_rerun()
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0, stderr)
        self.assertIn("separate-verifier-environment", self.report())

    def test_a_declared_mcp_task_that_the_job_did_not_run_is_refused(self) -> None:
        write_dataset_record_file(
            self.dataset_path, **{"Tasks with declared MCP servers": "\x60example-org/zulu\x60"}
        )
        self.write_standard_jobs()
        self.refused("did not run")

    def test_an_unreadable_job_directory_is_an_error(self) -> None:
        code, _, stderr = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("not a directory", stderr)
        self.assertFalse(self.output.exists())

    def test_a_malformed_oracle_record_is_an_error(self) -> None:
        self.write_standard_jobs()
        self.oracle_path.write_text(json.dumps({"schemaVersion": 2}), encoding="utf-8")
        code, _, stderr = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("schemaVersion", stderr)

    def test_a_missing_dataset_record_is_an_error(self) -> None:
        self.write_standard_jobs()
        code, _, stderr = self.run_main(dataset_record=self.root / "missing.md")
        self.assertEqual(code, 2)
        self.assertIn("does not exist", stderr)

    def test_a_missing_uv_lock_is_an_error(self) -> None:
        self.write_standard_jobs()
        code, _, stderr = self.run_main(uv_lock=self.root / "missing.lock")
        self.assertEqual(code, 2)
        self.assertIn("does not exist", stderr)

    def test_an_output_directory_that_cannot_be_written_is_an_error(self) -> None:
        self.write_standard_jobs()
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.write_text("not a directory", encoding="utf-8")
        code, _, stderr = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("cannot write", stderr)
        self.assertTrue(self.output.is_file())


class ArchiveCheckTest(unittest.TestCase):
    def test_a_record_without_archive_parts_is_refused(self) -> None:
        self.assertEqual(len(archive_problems([])), 1)

    def test_two_parts_with_one_file_name_are_refused(self) -> None:
        parts = [
            ArchivePart(file="part-aa", bytes=1, sha256="a" * 64),
            ArchivePart(file="part-aa", bytes=1, sha256="b" * 64),
        ]
        self.assertIn("share a file name", archive_problems(parts)[0])

    def test_a_part_at_the_two_gib_limit_is_refused(self) -> None:
        parts = [ArchivePart(file="part", bytes=GITHUB_RELEASE_PART_LIMIT_BYTES, sha256="a" * 64)]
        self.assertEqual(len(archive_problems(parts)), 1)

    def test_too_many_parts_are_refused(self) -> None:
        parts = [
            ArchivePart(file=f"part-{index}", bytes=1, sha256="a" * 64)
            for index in range(GITHUB_RELEASE_MAX_ASSETS + 1)
        ]
        self.assertIn(str(GITHUB_RELEASE_MAX_ASSETS), archive_problems(parts)[0])

    def test_small_parts_pass(self) -> None:
        self.assertEqual(archive_problems([ArchivePart(file="part", bytes=1, sha256="a" * 64)]), [])


class ReadJobTest(RecordTestCase):
    def test_an_empty_reward_dict_counts_as_no_reward(self) -> None:
        self.write_recorded(specs={**HEALTHY_SPECS, TASKS[0]: trial_spec(reward={})})
        job = read_job(self.recorded)
        self.assertIsNone({trial.task: trial for trial in job.trials}[TASKS[0]].reward)

    def test_a_reward_that_is_not_a_finite_number_is_refused(self) -> None:
        for reward in (True, float("nan"), float("inf")):
            with self.subTest(reward=reward):
                self.write_recorded(
                    specs={**HEALTHY_SPECS, TASKS[0]: trial_spec(reward={"reward": reward})}
                )
                with self.assertRaisesRegex(RecordError, "finite number"):
                    read_job(self.recorded)

    def test_a_reward_with_several_keys_is_read(self) -> None:
        self.write_recorded(
            specs={**HEALTHY_SPECS, TASKS[0]: trial_spec(reward={"reward": 1, "partial": 0.5})}
        )
        trial = {trial.task: trial for trial in read_job(self.recorded).trials}[TASKS[0]]
        self.assertEqual(dict(trial.reward or {}), {"reward": 1, "partial": 0.5})


if __name__ == "__main__":
    unittest.main()
