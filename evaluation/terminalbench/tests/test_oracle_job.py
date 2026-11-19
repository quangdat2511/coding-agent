"""The oracle job record of ADR 0005 §7 step 2.

The job directories here are written by hand in the shape that Harbor 0.23.0 writes. ADR 0008 §5
forbids a test to hardcode a dataset name, version or task count, so the dataset is made up.
"""

import contextlib
import hashlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from collections.abc import Sequence
from unittest import mock
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from harbor.models.environment_type import EnvironmentType
from harbor.models.job.config import DatasetConfig, JobConfig, RetryConfig
from harbor.models.job.lock import HarborLockInfo, JobLock, TaskLock, TrialLock, VerifierLock
from harbor.models.job.result import JobResult, JobStats
from harbor.models.trial.config import (
    AgentConfig,
    EnvironmentConfig,
    TaskConfig,
    TrialConfig,
    VerifierConfig,
)
from harbor.models.trial.result import AgentInfo, TrialResult
from harbor.models.verifier.result import VerifierResult

from coding_agent_terminalbench.oracle_job import (
    DatasetRecord,
    LockedPins,
    OracleJobError,
    check_oracle_job,
    main,
    oracle_record,
    read_locked_pins,
    read_oracle_job,
    resolve_release_commit,
    run_git,
)

DATASET = DatasetRecord(
    identifier="example-org/example-tasks@1.2.0",
    source_repository="https://example.com/example-org/example-tasks",
    release_tag="v1.2.0",
    release_commit="c" * 40,
)
PINS = LockedPins(harbor="0.23.0", modal="1.6.4")
TAG_OBJECT = "d" * 40
# The content hash that Harbor resolves the dataset version to.
CONTENT_HASH = "sha256:" + "a" * 64


def digest(task: str) -> str:
    return "sha256:" + hashlib.sha256(task.encode()).hexdigest()


def job_config(**overrides: Any) -> dict[str, Any]:
    config: dict[str, Any] = {
        "job_name": "oracle-example",
        "jobs_dir": "jobs",
        "n_attempts": 1,
        "timeout_multiplier": 1.0,
        "agent_timeout_multiplier": None,
        "verifier_timeout_multiplier": None,
        "agent_setup_timeout_multiplier": None,
        "environment_build_timeout_multiplier": None,
        "n_concurrent_trials": 4,
        "retry": {"max_retries": 0},
        "environment": {"type": "modal", "kwargs": {}},
        "verifier": {"disable": False},
        "agents": [{"name": "oracle", "kwargs": {}}],
        "datasets": [
            {
                "name": "example-org/example-tasks",
                "ref": "1.2.0",
                "task_names": None,
                "exclude_task_names": None,
                "n_tasks": None,
            }
        ],
        "tasks": [],
    }
    config.update(overrides)
    return config


def write_job(
    job_dir: Path,
    trials: dict[str, dict[str, Any] | None],
    *,
    config: dict[str, Any] | None = None,
    harbor_version: str = "0.23.0",
    finished: bool = True,
) -> None:
    """Writes a job directory. `trials` maps a task name to its verifier rewards, or to None."""
    job_dir.mkdir(parents=True)
    (job_dir / "config.json").write_text(json.dumps(config or job_config()))
    (job_dir / "lock.json").write_text(
        json.dumps(
            {
                "schema_version": 3,
                "harbor": {"version": harbor_version, "git_commit_hash": None},
                "n_concurrent_trials": 4,
                "retry": {"max_retries": 0},
                "trials": [
                    {"task": {"name": task, "type": "package", "digest": digest(task)}}
                    for task in trials
                ],
            }
        )
    )
    (job_dir / "result.json").write_text(
        json.dumps(
            {
                "id": "6f1c2a52-6b8e-4b5e-9a35-0c64d1f3f0aa",
                "started_at": "2026-11-20T01:00:00Z",
                "finished_at": "2026-11-20T03:30:00.500000Z" if finished else None,
                "n_total_trials": len(trials),
                "stats": {},
            }
        )
    )
    for index, (task, rewards) in enumerate(trials.items()):
        trial_dir = job_dir / f"{task.split('/')[-1]}__trial{index}"
        trial_dir.mkdir()
        result: dict[str, Any] = {
            "task_name": task,
            "trial_name": trial_dir.name,
            "verifier_result": None if rewards is None else {"rewards": rewards},
            "exception_info": None,
        }
        if rewards is None:
            result["exception_info"] = {"exception_type": "EnvironmentStartTimeoutError"}
        (trial_dir / "result.json").write_text(json.dumps(result))
        (trial_dir / "lock.json").write_text(
            json.dumps({"task": {"name": task, "type": "package", "digest": digest(task)}})
        )


def tag_lines(*lines: str) -> str:
    return "".join(f"{line}\n" for line in lines)


def annotated_tag(args: Sequence[str]) -> str:
    return tag_lines(
        f"{TAG_OBJECT}\trefs/tags/{DATASET.release_tag}",
        f"{DATASET.release_commit}\trefs/tags/{DATASET.release_tag}^{{}}",
    )


TRIALS: dict[str, dict[str, Any] | None] = {
    "example-org/alpha": {"reward": 1.0},
    "example-org/bravo": {"reward": 0.0},
    "example-org/charlie": {"reward": 1},
    "example-org/delta": None,
}


class OracleJobTestCase(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.job_dir = self.root / "jobs" / "oracle-example"

    def remove_job(self) -> None:
        """Removes the job directory, so a sub-test can write its own."""
        if self.job_dir.exists():
            shutil.rmtree(self.job_dir)

    def problems(self, **job: Any) -> list[str]:
        trials = job.pop("trials", TRIALS)
        write_job(self.job_dir, trials, **job)
        return check_oracle_job(
            read_oracle_job(self.job_dir),
            dataset=DATASET,
            pins=PINS,
            release_commit=DATASET.release_commit,
        )


class HarnessFlakyTasksTest(OracleJobTestCase):
    def test_lists_every_task_below_reward_1_with_its_reward(self) -> None:
        write_job(self.job_dir, TRIALS)
        job = read_oracle_job(self.job_dir)
        record = oracle_record(
            job, dataset=DATASET, pins=PINS, release_commit=DATASET.release_commit
        )
        self.assertEqual(
            record["harnessFlakyTasks"],
            [
                {"name": "example-org/bravo", "reward": 0.0, "exceptionType": None},
                {
                    "name": "example-org/delta",
                    "reward": None,
                    "exceptionType": "EnvironmentStartTimeoutError",
                },
            ],
        )
        self.assertEqual(len(record["tasks"]), 4)
        self.assertEqual(record["tasks"][0]["digest"], digest("example-org/alpha"))

    def test_a_partial_reward_is_harness_flaky(self) -> None:
        write_job(self.job_dir, {"example-org/alpha": {"reward": 0.99}})
        job = read_oracle_job(self.job_dir)
        self.assertTrue(job.tasks[0].harness_flaky)

    def test_an_empty_reward_dict_counts_as_no_reward(self) -> None:
        write_job(self.job_dir, {"example-org/alpha": {}})
        self.assertIsNone(read_oracle_job(self.job_dir).tasks[0].reward)

    def test_several_reward_keys_are_refused(self) -> None:
        write_job(self.job_dir, {"example-org/alpha": {"reward": 1, "partial": 0.5}})
        with self.assertRaisesRegex(OracleJobError, "several keys"):
            read_oracle_job(self.job_dir)

    def test_a_reward_that_is_not_a_number_is_refused(self) -> None:
        write_job(self.job_dir, {"example-org/alpha": {"reward": True}})
        with self.assertRaisesRegex(OracleJobError, "must be a number"):
            read_oracle_job(self.job_dir)


class RecordTest(OracleJobTestCase):
    def test_records_the_pins_dataset_flags_and_wall_clock(self) -> None:
        write_job(self.job_dir, TRIALS)
        record = oracle_record(
            read_oracle_job(self.job_dir),
            dataset=DATASET,
            pins=PINS,
            release_commit=DATASET.release_commit,
        )
        self.assertEqual(record["harbor"], {"version": "0.23.0", "gitCommitHash": None})
        self.assertEqual(record["modalSdk"], {"version": "1.6.4", "source": "uv.lock"})
        self.assertEqual(
            record["dataset"],
            {
                "identifier": DATASET.identifier,
                "resolvedReference": "1.2.0",
                "sourceRepository": DATASET.source_repository,
                "releaseTag": DATASET.release_tag,
                "releaseCommit": DATASET.release_commit,
                "releaseCommitResolvedBy": (
                    f"git ls-remote --tags {DATASET.source_repository} "
                    f"refs/tags/{DATASET.release_tag}"
                ),
                "taskCount": 4,
            },
        )
        self.assertEqual(
            record["flags"],
            {
                "agent": "oracle",
                "environment": "modal",
                "nAttempts": 1,
                "nConcurrentTrials": 4,
                "maxRetries": 0,
            },
        )
        self.assertEqual(record["job"]["name"], "oracle-example")
        self.assertEqual(record["job"]["wallClockSeconds"], 9000.5)
        self.assertEqual(
            record["environmentVariableNames"], {"agent": [], "environment": [], "verifier": []}
        )


class CheckTest(OracleJobTestCase):
    def test_a_job_that_follows_the_procedure_has_no_problem(self) -> None:
        self.assertEqual(self.problems(), [])

    def test_another_agent_is_refused(self) -> None:
        config = job_config(agents=[{"name": "nop"}])
        self.assertIn("built-in `oracle`", " ".join(self.problems(config=config)))

    def test_a_model_is_refused(self) -> None:
        config = job_config(agents=[{"name": "oracle", "model_name": "opencode/some-model"}])
        self.assertIn("takes no model", " ".join(self.problems(config=config)))

    def test_another_environment_is_refused(self) -> None:
        config = job_config(environment={"type": "docker"})
        self.assertIn("-e modal", " ".join(self.problems(config=config)))

    def test_more_than_one_attempt_is_refused(self) -> None:
        self.assertIn("-k 1", " ".join(self.problems(config=job_config(n_attempts=3))))

    def test_retries_are_refused(self) -> None:
        config = job_config(retry={"max_retries": 2})
        self.assertIn("-r 0", " ".join(self.problems(config=config)))

    def test_a_timeout_multiplier_is_refused(self) -> None:
        for field, value in (("timeout_multiplier", 2.0), ("agent_timeout_multiplier", 0.5)):
            with self.subTest(field=field):
                self.remove_job()
                problems = self.problems(config=job_config(**{field: value}))
                self.assertIn("task timeouts", " ".join(problems))

    def test_task_filtering_is_refused(self) -> None:
        for field, value in (
            ("task_names", ["example-org/alpha"]),
            ("exclude_task_names", ["example-org/bravo"]),
            ("n_tasks", 2),
        ):
            with self.subTest(field=field):
                self.remove_job()
                dataset = dict(job_config()["datasets"][0], **{field: value})
                problems = self.problems(config=job_config(datasets=[dataset]))
                self.assertIn(f"({field} is set)", " ".join(problems))

    def test_another_dataset_is_refused(self) -> None:
        dataset = dict(job_config()["datasets"][0], ref="1.1.0")
        problems = self.problems(config=job_config(datasets=[dataset]))
        self.assertIn("example-org/example-tasks@1.1.0", " ".join(problems))

    def test_the_content_hash_that_harbor_resolved_is_accepted_and_recorded(self) -> None:
        dataset = dict(job_config()["datasets"][0], ref=CONTENT_HASH)
        config = job_config(datasets=[dataset])
        self.assertEqual(self.problems(config=config), [])
        record = oracle_record(
            read_oracle_job(self.job_dir),
            dataset=DATASET,
            pins=PINS,
            release_commit=DATASET.release_commit,
        )
        self.assertEqual(record["dataset"]["identifier"], DATASET.identifier)
        self.assertEqual(record["dataset"]["resolvedReference"], CONTENT_HASH)

    def test_another_dataset_name_is_refused(self) -> None:
        for ref in ("1.2.0", CONTENT_HASH):
            with self.subTest(ref=ref):
                self.remove_job()
                dataset = dict(job_config()["datasets"][0], name="example-org/other", ref=ref)
                problems = self.problems(config=job_config(datasets=[dataset]))
                self.assertIn(f"example-org/other@{ref}", " ".join(problems))

    def test_a_registry_dataset_reads_its_version(self) -> None:
        dataset = {"name": "example-org/example-tasks", "version": "1.2.0"}
        self.assertEqual(self.problems(config=job_config(datasets=[dataset])), [])

    def test_two_datasets_are_refused(self) -> None:
        dataset = job_config()["datasets"][0]
        problems = self.problems(config=job_config(datasets=[dataset, dataset]))
        self.assertIn("exactly one dataset", " ".join(problems))

    def test_another_harbor_version_is_refused(self) -> None:
        problems = self.problems(harbor_version="0.24.0")
        self.assertIn("uv.lock pins 0.23.0", " ".join(problems))

    def test_a_release_commit_that_differs_from_the_record_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        problems = check_oracle_job(
            read_oracle_job(self.job_dir), dataset=DATASET, pins=PINS, release_commit="e" * 40
        )
        self.assertIn("but the dataset record names", " ".join(problems))

    def test_an_agent_variable_is_refused(self) -> None:
        config = job_config(agents=[{"name": "oracle", "env": {"DEBUG": "1"}}])
        self.assertIn("passes DEBUG", " ".join(self.problems(config=config)))

    def test_a_provider_key_anywhere_is_refused(self) -> None:
        for section in ("environment", "verifier"):
            with self.subTest(section=section):
                self.remove_job()
                base = job_config()[section]
                config = job_config(**{section: dict(base, env={"OPENCODE_API_KEY": "${X}"})})
                problems = self.problems(config=config)
                self.assertIn("credential variable OPENCODE_API_KEY", " ".join(problems))

    def test_an_unfinished_job_is_refused(self) -> None:
        self.assertIn("no finished_at", " ".join(self.problems(finished=False)))

    def test_a_trial_without_result_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        (self.job_dir / "echo__trial9").mkdir()
        problems = check_oracle_job(
            read_oracle_job(self.job_dir),
            dataset=DATASET,
            pins=PINS,
            release_commit=DATASET.release_commit,
        )
        self.assertIn("trial echo__trial9 did not finish", " ".join(problems))

    def test_hidden_directories_are_not_trials(self) -> None:
        write_job(self.job_dir, TRIALS)
        (self.job_dir / ".sources").mkdir()
        self.assertEqual(len(read_oracle_job(self.job_dir).tasks), 4)

    def test_a_missing_trial_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        trial = next(self.job_dir.glob("alpha__*"))
        for file in trial.iterdir():
            file.unlink()
        trial.rmdir()
        problems = check_oracle_job(
            read_oracle_job(self.job_dir),
            dataset=DATASET,
            pins=PINS,
            release_commit=DATASET.release_commit,
        )
        self.assertIn("3 finished trials, lock.json plans 4", " ".join(problems))

    def test_a_trial_without_lock_still_checks_the_other_digests(self) -> None:
        write_job(self.job_dir, TRIALS)
        (next(self.job_dir.glob("alpha__*")) / "lock.json").unlink()
        self.assertEqual(
            check_oracle_job(
                read_oracle_job(self.job_dir),
                dataset=DATASET,
                pins=PINS,
                release_commit=DATASET.release_commit,
            ),
            [],
        )
        bravo_lock = next(self.job_dir.glob("bravo__*")) / "lock.json"
        bravo_lock.write_text(json.dumps({"task": {"digest": digest("example-org/unplanned")}}))
        problems = check_oracle_job(
            read_oracle_job(self.job_dir),
            dataset=DATASET,
            pins=PINS,
            release_commit=DATASET.release_commit,
        )
        self.assertIn("task digests of the trials differ", " ".join(problems))


class ReadTest(OracleJobTestCase):
    def test_a_missing_job_directory_is_refused(self) -> None:
        with self.assertRaisesRegex(OracleJobError, "not a directory"):
            read_oracle_job(self.job_dir)

    def test_a_missing_file_names_it(self) -> None:
        write_job(self.job_dir, TRIALS)
        (self.job_dir / "lock.json").unlink()
        with self.assertRaisesRegex(OracleJobError, "lock.json does not exist"):
            read_oracle_job(self.job_dir)

    def test_invalid_json_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        (self.job_dir / "config.json").write_text("{")
        with self.assertRaisesRegex(OracleJobError, "not valid JSON"):
            read_oracle_job(self.job_dir)

    def test_reads_the_locked_pins_of_the_adapter(self) -> None:
        uv_lock = Path(__file__).resolve().parent.parent / "uv.lock"
        pins = read_locked_pins(uv_lock)
        self.assertEqual(pins.harbor, "0.23.0")
        self.assertRegex(pins.modal, r"^\d+\.\d+\.\d+$")


class ResolveReleaseCommitTest(unittest.TestCase):
    def test_an_annotated_tag_resolves_to_its_peeled_commit(self) -> None:
        commit = resolve_release_commit(
            DATASET.source_repository, DATASET.release_tag, annotated_tag
        )
        self.assertEqual(commit, DATASET.release_commit)

    def test_a_lightweight_tag_resolves_to_its_commit(self) -> None:
        def lightweight(args: Sequence[str]) -> str:
            return tag_lines(f"{DATASET.release_commit}\trefs/tags/{DATASET.release_tag}")

        commit = resolve_release_commit(DATASET.source_repository, DATASET.release_tag, lightweight)
        self.assertEqual(commit, DATASET.release_commit)

    def test_asks_git_for_the_tag_and_its_peeled_ref(self) -> None:
        calls: list[Sequence[str]] = []

        def record(args: Sequence[str]) -> str:
            calls.append(list(args))
            return annotated_tag(args)

        resolve_release_commit(DATASET.source_repository, DATASET.release_tag, record)
        self.assertEqual(
            calls,
            [
                [
                    "ls-remote",
                    "--tags",
                    DATASET.source_repository,
                    "refs/tags/v1.2.0",
                    "refs/tags/v1.2.0^{}",
                ]
            ],
        )

    def test_a_missing_tag_is_refused(self) -> None:
        with self.assertRaisesRegex(OracleJobError, "has no tag v1.2.0"):
            resolve_release_commit(DATASET.source_repository, DATASET.release_tag, lambda _: "")


class RunGitTest(unittest.TestCase):
    def test_a_missing_git_is_an_oracle_job_error(self) -> None:
        with (
            mock.patch("subprocess.run", side_effect=FileNotFoundError("git")),
            self.assertRaisesRegex(OracleJobError, "cannot run git ls-remote"),
        ):
            run_git(["ls-remote"])

    def test_a_git_that_does_not_answer_is_an_oracle_job_error(self) -> None:
        timeout = subprocess.TimeoutExpired(["git", "ls-remote"], 60)
        with (
            mock.patch("subprocess.run", side_effect=timeout),
            self.assertRaisesRegex(OracleJobError, "did not answer in 60 s"),
        ):
            run_git(["ls-remote"])

    def test_a_failing_git_names_its_exit_code(self) -> None:
        failed = subprocess.CompletedProcess(["git"], 128, stdout="", stderr="fatal: no repo\n")
        with (
            mock.patch("subprocess.run", return_value=failed),
            self.assertRaisesRegex(OracleJobError, "exited 128: fatal: no repo"),
        ):
            run_git(["ls-remote"])


class HarborShapeTest(OracleJobTestCase):
    """Harbor's own models write the job directory, the way `Job` and `Trial` serialize them."""

    def write_harbor_job(self, config: JobConfig) -> None:
        tasks = {"example-org/alpha": 1.0, "example-org/bravo": 0.0}
        self.job_dir.mkdir(parents=True)
        # `Job.create` resolves each package dataset before `Job.run` writes config.json, and the
        # resolution replaces the dataset's ref with the version's content hash.
        for dataset in config.datasets:
            if dataset.name is not None and "/" in dataset.name:
                dataset.ref = CONTENT_HASH
        # harbor/job.py writes config.json with exclude_defaults, lock.json with exclude_none.
        (self.job_dir / "config.json").write_text(
            config.model_dump_json(indent=4, exclude_defaults=True)
        )
        locks = []
        for index, (task, reward) in enumerate(tasks.items()):
            task_config = TaskConfig(name=task, ref=digest(task))
            lock = TrialLock(
                task=TaskLock(name=task, type="package", digest=digest(task)),
                agent=config.agents[0],
                environment=config.environment,
                verifier=VerifierLock(),
            )
            locks.append(lock)
            trial_name = f"{task.split('/')[-1]}__trial{index}"
            result = TrialResult(
                task_name=task,
                trial_name=trial_name,
                trial_uri=f"file:///jobs/{trial_name}",
                task_id=task_config.get_task_id(),
                task_checksum=digest(task),
                config=TrialConfig(task=task_config, agent=config.agents[0]),
                agent_info=AgentInfo(name="oracle", version="1.0.0"),
                verifier_result=VerifierResult(rewards={"reward": reward}),
            )
            trial_dir = self.job_dir / trial_name
            trial_dir.mkdir()
            (trial_dir / "result.json").write_text(result.model_dump_json(indent=4))
            (trial_dir / "lock.json").write_text(lock.model_dump_json(indent=4, exclude_none=True))
        job_lock = JobLock(
            harbor=HarborLockInfo(version="0.23.0"),
            n_concurrent_trials=config.n_concurrent_trials,
            retry=config.retry,
            trials=locks,
        )
        (self.job_dir / "lock.json").write_text(
            job_lock.model_dump_json(indent=4, exclude_none=True)
        )
        started = datetime(2026, 11, 20, 1, 0, tzinfo=UTC)
        job_result = JobResult(
            id=uuid4(),
            started_at=started,
            finished_at=started + timedelta(minutes=90),
            n_total_trials=len(tasks),
            stats=JobStats(),
        )
        (self.job_dir / "result.json").write_text(
            job_result.model_dump_json(indent=4, exclude={"trial_results"})
        )

    def oracle_config(self, **overrides: Any) -> JobConfig:
        # What `harbor run -d example-org/example-tasks@1.2.0 -a oracle -e modal -k 1` builds.
        values: dict[str, Any] = {
            "job_name": "oracle-example",
            "agents": [AgentConfig(name="oracle")],
            "environment": EnvironmentConfig(type=EnvironmentType.MODAL),
            "datasets": [DatasetConfig(name="example-org/example-tasks", ref="1.2.0")],
        }
        values.update(overrides)
        return JobConfig(**values)

    def check(self) -> list[str]:
        return check_oracle_job(
            read_oracle_job(self.job_dir),
            dataset=DATASET,
            pins=PINS,
            release_commit=DATASET.release_commit,
        )

    def test_the_oracle_command_has_no_problem_and_its_defaults_are_recorded(self) -> None:
        self.write_harbor_job(self.oracle_config())
        self.assertEqual(self.check(), [])
        record = oracle_record(
            read_oracle_job(self.job_dir),
            dataset=DATASET,
            pins=PINS,
            release_commit=DATASET.release_commit,
        )
        self.assertEqual(
            record["flags"],
            {
                "agent": "oracle",
                "environment": "modal",
                "nAttempts": 1,
                "nConcurrentTrials": 4,
                "maxRetries": 0,
            },
        )
        self.assertEqual(record["job"]["wallClockSeconds"], 5400.0)
        self.assertEqual(record["dataset"]["identifier"], DATASET.identifier)
        self.assertEqual(record["dataset"]["resolvedReference"], CONTENT_HASH)
        self.assertEqual(
            record["harnessFlakyTasks"],
            [{"name": "example-org/bravo", "reward": 0.0, "exceptionType": None}],
        )
        self.assertEqual(record["tasks"][0]["digest"], digest("example-org/alpha"))

    def test_flags_that_harbor_writes_are_read(self) -> None:
        self.write_harbor_job(
            self.oracle_config(
                n_attempts=2, retry=RetryConfig(max_retries=1), n_concurrent_trials=8
            )
        )
        problems = " ".join(self.check())
        self.assertIn("-k 1", problems)
        self.assertIn("-r 0", problems)

    def test_a_custom_agent_is_refused(self) -> None:
        agent = AgentConfig(import_path="coding_agent_terminalbench.agent:CodingAgent")
        self.write_harbor_job(self.oracle_config(agents=[agent]))
        self.assertIn("built-in `oracle`", " ".join(self.check()))

    def test_overrides_of_the_task_conditions_are_refused(self) -> None:
        cases = {
            "agent override_timeout_sec": {
                "agents": [AgentConfig(name="oracle", override_timeout_sec=60)]
            },
            "environment override_gpus": {
                "environment": EnvironmentConfig(type=EnvironmentType.MODAL, override_gpus=0)
            },
            "verifier max_timeout_sec": {"verifier": VerifierConfig(max_timeout_sec=60)},
        }
        for expected, overrides in cases.items():
            with self.subTest(override=expected):
                self.remove_job()
                self.write_harbor_job(self.oracle_config(**overrides))
                self.assertIn(f"({expected} is set)", " ".join(self.check()))

    def test_a_disabled_verifier_is_refused(self) -> None:
        self.write_harbor_job(self.oracle_config(verifier=VerifierConfig(disable=True)))
        self.assertIn("must run the verifier", " ".join(self.check()))

    def test_an_agent_environment_variable_is_read(self) -> None:
        agent = AgentConfig(name="oracle", env={"OPENCODE_API_KEY": "${OPENCODE_API_KEY}"})
        self.write_harbor_job(self.oracle_config(agents=[agent]))
        self.assertIn("credential variable OPENCODE_API_KEY", " ".join(self.check()))


class MainTest(OracleJobTestCase):
    def run_main(self) -> tuple[int, str, str]:
        output = self.root / "runs" / "oracle-example" / "oracle.json"
        uv_lock = Path(__file__).resolve().parent.parent / "uv.lock"
        argv = [
            str(self.job_dir),
            "--dataset",
            DATASET.identifier,
            "--source-repository",
            DATASET.source_repository,
            "--release-tag",
            DATASET.release_tag,
            "--release-commit",
            DATASET.release_commit,
            "--output",
            str(output),
            "--uv-lock",
            str(uv_lock),
        ]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(argv, run=annotated_tag)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_writes_the_record_and_prints_the_flaky_tasks(self) -> None:
        write_job(self.job_dir, TRIALS)
        code, stdout, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("Tasks: 4, harness-flaky: 2", stdout)
        self.assertIn("example-org/bravo: reward 0.0", stdout)
        self.assertIn("example-org/delta: no reward, EnvironmentStartTimeoutError", stdout)
        record = json.loads((self.root / "runs" / "oracle-example" / "oracle.json").read_text())
        self.assertEqual(record["schemaVersion"], 1)
        self.assertEqual(len(record["harnessFlakyTasks"]), 2)

    def test_a_job_with_problems_writes_nothing(self) -> None:
        write_job(self.job_dir, TRIALS, config=job_config(n_attempts=2))
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("-k 1", stderr)
        self.assertFalse((self.root / "runs").exists())

    def test_an_unreadable_job_exits_2(self) -> None:
        code, _, stderr = self.run_main()
        self.assertEqual(code, 2)
        self.assertIn("not a directory", stderr)


if __name__ == "__main__":
    unittest.main()
