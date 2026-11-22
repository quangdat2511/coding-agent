"""The oracle job record of ADR 0005 §7 step 2.

Most job directories here are written by hand in the shape that Harbor 0.23.0 writes, so a test can
write a shape that Harbor's models refuse. `HarborShapeTest` writes them with Harbor's own models
and builds the config with Harbor's own CLI. ADR 0008 §5 forbids a test to hardcode a dataset name,
version or task count, so the dataset is made up and the counts come from the fixtures.
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
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from unittest import mock
from uuid import uuid4

from harbor.models.bridge import BridgeConfig
from harbor.models.job.config import JobConfig
from harbor.models.job.lock import HarborLockInfo, JobLock, TaskLock, TrialLock, VerifierLock
from harbor.models.job.result import JobResult, JobStats
from harbor.models.registry import DatasetMetadata
from harbor.models.task.id import PackageTaskId
from harbor.models.trial.config import (
    AgentConfig,
    EnvironmentConfig,
    TaskConfig,
    TrialConfig,
    UserAgentConfig,
    VerifierConfig,
)
from harbor.models.trial.result import AgentInfo, TrialResult
from harbor.models.verifier.result import VerifierResult

from coding_agent_terminalbench.oracle_job import (
    DatasetRecord,
    Evidence,
    LockedPins,
    OracleJobError,
    RegistryDataset,
    check_oracle_job,
    main,
    oracle_record,
    read_locked_pins,
    read_oracle_job,
    resolve_registry_dataset,
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
# The content hash that Harbor's registry resolves the dataset version to.
CONTENT_HASH = "sha256:" + "a" * 64
UV_LOCK = Path(__file__).resolve().parent.parent / "uv.lock"


def digest(task: str) -> str:
    return "sha256:" + hashlib.sha256(task.encode()).hexdigest()


TRIALS: dict[str, dict[str, Any] | None] = {
    "example-org/alpha": {"reward": 1.0},
    "example-org/bravo": {"reward": 0.0},
    "example-org/charlie": {"reward": 1},
    "example-org/delta": None,
}


def registry_of(tasks: Sequence[str]) -> RegistryDataset:
    return RegistryDataset(
        content_hash=CONTENT_HASH, tasks=tuple(sorted((task, digest(task)) for task in tasks))
    )


EVIDENCE = Evidence(
    dataset=DATASET, pins=PINS, release_commit=DATASET.release_commit, registry=registry_of(TRIALS)
)


def job_config(**overrides: Any) -> dict[str, Any]:
    """The config.json that the oracle command of the README writes (see `HarborShapeTest`)."""
    config: dict[str, Any] = {
        "job_name": "oracle-example",
        "n_concurrent_trials": 16,
        "environment": {"type": "modal"},
        "datasets": [{"name": "example-org/example-tasks", "ref": CONTENT_HASH}],
    }
    config.update(overrides)
    return config


def write_job(
    job_dir: Path,
    trials: dict[str, dict[str, Any] | None],
    *,
    config: dict[str, Any] | None = None,
    harbor_version: str = "0.23.0",
    result: dict[str, Any] | None = None,
) -> None:
    """Writes a job directory. `trials` maps a task name to its verifier rewards, or to None."""
    job_dir.mkdir(parents=True)
    (job_dir / "config.json").write_text(json.dumps(config or job_config()))
    (job_dir / "lock.json").write_text(
        json.dumps(
            {
                "schema_version": 3,
                "harbor": {"version": harbor_version, "git_commit_hash": None},
                "n_concurrent_trials": 16,
                "retry": {"max_retries": 0},
                "trials": [
                    {"task": {"name": task, "type": "package", "digest": digest(task)}}
                    for task in trials
                ],
            }
        )
    )
    job_result: dict[str, Any] = {
        "id": "6f1c2a52-6b8e-4b5e-9a35-0c64d1f3f0aa",
        "started_at": "2026-11-20T01:00:00Z",
        "finished_at": "2026-11-20T03:30:00.500000Z",
        "n_total_trials": len(trials),
        "stats": {},
    }
    job_result.update(result or {})
    (job_dir / "result.json").write_text(json.dumps(job_result))
    for index, (task, rewards) in enumerate(trials.items()):
        trial_dir = job_dir / f"{task.split('/')[-1]}__trial{index}"
        trial_dir.mkdir()
        trial_result: dict[str, Any] = {
            "task_name": task.split("/")[-1],
            "trial_name": trial_dir.name,
            "verifier_result": None if rewards is None else {"rewards": rewards},
            "exception_info": None,
        }
        if rewards is None:
            trial_result["exception_info"] = {"exception_type": "EnvironmentStartTimeoutError"}
        (trial_dir / "result.json").write_text(json.dumps(trial_result))
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

    def check(self, evidence: Evidence = EVIDENCE) -> list[str]:
        return check_oracle_job(read_oracle_job(self.job_dir), evidence)

    def record(self) -> dict[str, Any]:
        return oracle_record(read_oracle_job(self.job_dir), EVIDENCE)

    def problems(self, **job: Any) -> str:
        """Writes a job directory and returns its problems as one string."""
        write_job(self.job_dir, job.pop("trials", TRIALS), **job)
        return " ".join(self.check())

    def trial_dir(self, task: str) -> Path:
        return next(self.job_dir.glob(f"{task}__*"))


class HarnessFlakyTasksTest(OracleJobTestCase):
    def test_lists_every_task_below_reward_1_with_its_reward(self) -> None:
        write_job(self.job_dir, TRIALS)
        record = self.record()
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
        self.assertEqual(len(record["tasks"]), len(TRIALS))
        self.assertEqual(record["tasks"][0]["digest"], digest("example-org/alpha"))

    def test_a_partial_reward_is_harness_flaky(self) -> None:
        write_job(self.job_dir, {"example-org/alpha": {"reward": 0.99}})
        self.assertTrue(read_oracle_job(self.job_dir).tasks[0].harness_flaky)

    def test_an_empty_reward_dict_counts_as_no_reward(self) -> None:
        write_job(self.job_dir, {"example-org/alpha": {}})
        self.assertIsNone(read_oracle_job(self.job_dir).tasks[0].reward)

    def test_several_reward_keys_are_refused(self) -> None:
        write_job(self.job_dir, {"example-org/alpha": {"reward": 1, "partial": 0.5}})
        with self.assertRaisesRegex(OracleJobError, "several keys"):
            read_oracle_job(self.job_dir)

    def test_a_reward_that_is_not_a_finite_number_is_refused(self) -> None:
        for reward in (True, float("nan"), float("inf")):
            with self.subTest(reward=reward):
                self.remove_job()
                write_job(self.job_dir, {"example-org/alpha": {"reward": reward}})
                with self.assertRaisesRegex(OracleJobError, "must be a finite number"):
                    read_oracle_job(self.job_dir)


class RecordTest(OracleJobTestCase):
    def test_records_the_pins_dataset_flags_command_and_wall_clock(self) -> None:
        write_job(self.job_dir, TRIALS)
        record = self.record()
        self.assertEqual(record["harbor"], {"version": "0.23.0", "gitCommitHash": None})
        self.assertEqual(record["modalSdk"], {"version": "1.6.4", "source": "uv.lock"})
        self.assertEqual(
            record["dataset"],
            {
                "identifier": DATASET.identifier,
                "contentHash": CONTENT_HASH,
                "contentHashResolvedBy": (
                    "Harbor's package registry, the lookup that `harbor run -d` makes"
                ),
                "sourceRepository": DATASET.source_repository,
                "releaseTag": DATASET.release_tag,
                "releaseCommit": DATASET.release_commit,
                "releaseCommitResolvedBy": (
                    f"git ls-remote --tags {DATASET.source_repository} "
                    f"refs/tags/{DATASET.release_tag} refs/tags/{DATASET.release_tag}^{{}}"
                ),
                "taskCount": len(TRIALS),
            },
        )
        self.assertEqual(
            record["flags"],
            {
                "agent": "oracle",
                "environment": "modal",
                "nAttempts": 1,
                "nConcurrentTrials": 16,
                "maxRetries": 0,
            },
        )
        self.assertEqual(
            record["command"],
            f"harbor run -d {DATASET.identifier} -a oracle -e modal -k 1 -n 16 -r 0 "
            "-o jobs --job-name oracle-example",
        )
        self.assertEqual(record["job"]["name"], "oracle-example")
        self.assertEqual(record["job"]["wallClockSeconds"], 9000.5)
        self.assertEqual(record["environmentVariableNames"], [])

    def test_the_task_count_comes_from_the_planned_trials(self) -> None:
        write_job(self.job_dir, TRIALS)
        shutil.rmtree(self.trial_dir("alpha"))
        self.assertEqual(self.record()["dataset"]["taskCount"], len(TRIALS))


class ConfigCheckTest(OracleJobTestCase):
    def test_the_config_of_the_oracle_command_has_no_problem(self) -> None:
        self.assertEqual(self.problems(), "")

    def test_another_agent_is_refused(self) -> None:
        for agents in ([{"name": "nop"}], [{"name": "oracle"}, {"name": "oracle"}], ["oracle"]):
            with self.subTest(agents=agents):
                self.remove_job()
                self.assertIn("built-in `oracle`", self.problems(config=job_config(agents=agents)))

    def test_another_environment_is_refused(self) -> None:
        problems = self.problems(config=job_config(environment={"type": "docker"}))
        self.assertIn("-e modal", problems)

    def test_every_field_that_the_oracle_command_does_not_set_is_refused(self) -> None:
        dataset = job_config()["datasets"][0]
        cases: dict[str, dict[str, Any]] = {
            "`n_attempts`, which the oracle command leaves at its default (run with -k 1)": {
                "n_attempts": 3
            },
            "`retry`, which the oracle command leaves at its default (run with -r 0)": {
                "retry": {"max_retries": 2}
            },
            "`timeout_multiplier`": {"timeout_multiplier": 2.0},
            "`agent_timeout_multiplier`": {"agent_timeout_multiplier": 0.5},
            "`install_only`": {"install_only": True},
            "`extra_instructions`": {"extra_instructions": ["Always pass."]},
            "`user_agent`": {"user_agent": {"name": "simulated"}},
            "`tasks`": {"tasks": [{"name": "example-org/alpha"}]},
            "`verifier`": {"verifier": {"import_path": "example:AlwaysOne"}},
            "`agents[0].model_name`": {
                "agents": [{"name": "oracle", "model_name": "opencode/some-model"}]
            },
            "`agents[0].override_timeout_sec`": {
                "agents": [{"name": "oracle", "override_timeout_sec": 60}]
            },
            "`environment.import_path`": {
                "environment": {"type": "modal", "import_path": "example:Environment"}
            },
            "`environment.mounts`": {"environment": {"type": "modal", "mounts": []}},
            "`environment.kwargs`": {"environment": {"type": "modal", "kwargs": {"a": 1}}},
            "`environment.override_gpus`": {"environment": {"type": "modal", "override_gpus": 0}},
            "`datasets[0].task_names`": {
                "datasets": [dict(dataset, task_names=["example-org/alpha"])]
            },
            "`datasets[0].n_tasks`": {"datasets": [dict(dataset, n_tasks=2)]},
        }
        for expected, overrides in cases.items():
            with self.subTest(field=expected):
                self.remove_job()
                self.assertIn(expected, self.problems(config=job_config(**overrides)))

    def test_two_datasets_are_refused(self) -> None:
        dataset = job_config()["datasets"][0]
        problems = self.problems(config=job_config(datasets=[dataset, dataset]))
        self.assertIn("exactly one dataset", problems)

    def test_a_provider_key_anywhere_is_named(self) -> None:
        key = {"env": {"OPENCODE_API_KEY": "${OPENCODE_API_KEY}"}}
        for overrides in (
            {"agents": [dict({"name": "oracle"}, **key)]},
            {"environment": dict({"type": "modal"}, **key)},
            {"verifier": key},
            {"user_agent": dict({"name": "simulated"}, **key)},
        ):
            with self.subTest(section=next(iter(overrides))):
                self.remove_job()
                problems = self.problems(config=job_config(**overrides))
                self.assertIn("credential variable OPENCODE_API_KEY", problems)


class DatasetCheckTest(OracleJobTestCase):
    def test_another_dataset_name_is_refused(self) -> None:
        dataset = dict(job_config()["datasets"][0], name="example-org/other")
        problems = self.problems(config=job_config(datasets=[dataset]))
        self.assertIn('"example-org/other", but the dataset record is', problems)

    def test_content_that_the_registry_does_not_resolve_is_refused(self) -> None:
        # A job of another version of the same dataset has another content hash.
        other = "sha256:" + "b" * 64
        dataset = dict(job_config()["datasets"][0], ref=other)
        problems = self.problems(config=job_config(datasets=[dataset]))
        self.assertIn(f'content "{other}", but Harbor\'s registry resolves', problems)

    def test_planned_tasks_that_differ_from_the_registry_are_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        registry = registry_of([*list(TRIALS)[1:], "example-org/echo"])
        evidence = Evidence(DATASET, PINS, DATASET.release_commit, registry)
        problems = " ".join(self.check(evidence))
        self.assertIn(
            f"lock.json plans {len(TRIALS)} tasks, and 1 of them are not in", problems
        )

    def test_another_harbor_version_is_refused(self) -> None:
        self.assertIn("uv.lock pins 0.23.0", self.problems(harbor_version="0.24.0"))

    def test_a_release_commit_that_differs_from_the_record_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        evidence = Evidence(DATASET, PINS, "e" * 40, EVIDENCE.registry)
        self.assertIn("but the dataset record names", " ".join(self.check(evidence)))


class ResultCheckTest(OracleJobTestCase):
    def test_an_unfinished_job_is_refused(self) -> None:
        self.assertIn("no finished_at", self.problems(result={"finished_at": None}))

    def test_a_job_without_id_or_start_is_refused(self) -> None:
        for field, expected in (("id", "no job id"), ("started_at", "no started_at")):
            with self.subTest(field=field):
                self.remove_job()
                self.assertIn(expected, self.problems(result={field: None}))

    def test_times_that_cannot_be_compared_are_refused(self) -> None:
        cases = {
            "both have a time zone": {"finished_at": "2026-11-20T03:30:00"},
            "finished_at time before its started_at": {"finished_at": "2026-11-20T00:30:00Z"},
            "finished_at time that cannot be read": {"finished_at": "later"},
        }
        for expected, result in cases.items():
            with self.subTest(case=expected):
                self.remove_job()
                self.assertIn(expected, self.problems(result=result))


class TrialCheckTest(OracleJobTestCase):
    def test_a_trial_without_result_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        (self.job_dir / "echo__trial9").mkdir()
        self.assertIn("trial echo__trial9 did not finish", " ".join(self.check()))

    def test_hidden_directories_are_not_trials(self) -> None:
        write_job(self.job_dir, TRIALS)
        (self.job_dir / ".sources").mkdir()
        self.assertEqual(len(read_oracle_job(self.job_dir).tasks), len(TRIALS))

    def test_a_missing_trial_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        shutil.rmtree(self.trial_dir("alpha"))
        expected = f"{len(TRIALS) - 1} finished trials, lock.json plans {len(TRIALS)}"
        self.assertIn(expected, " ".join(self.check()))

    def test_a_trial_without_lock_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        trial = self.trial_dir("alpha")
        (trial / "lock.json").unlink()
        self.assertIn(f"trial {trial.name} has no task digest", " ".join(self.check()))

    def test_an_unplanned_trial_in_place_of_a_planned_one_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        bravo = self.trial_dir("bravo")
        (bravo / "lock.json").write_text(
            json.dumps({"task": {"name": "example-org/unplanned", "digest": digest("unplanned")}})
        )
        self.assertIn("tasks that lock.json does not plan", " ".join(self.check()))


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

    def test_a_file_that_is_not_utf8_is_refused(self) -> None:
        write_job(self.job_dir, TRIALS)
        (self.job_dir / "config.json").write_bytes(b"\xff\xfe")
        with self.assertRaisesRegex(OracleJobError, "cannot read .*config.json"):
            read_oracle_job(self.job_dir)
        uv_lock = self.root / "uv.lock"
        uv_lock.write_bytes(b"\xff\xfe")
        with self.assertRaisesRegex(OracleJobError, "cannot read .*uv.lock"):
            read_locked_pins(uv_lock)

    def test_reads_the_locked_pins_of_the_adapter(self) -> None:
        pins = read_locked_pins(UV_LOCK)
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


class ResolveRegistryDatasetTest(unittest.TestCase):
    CLIENT = "harbor.registry.client.package.PackageDatasetClient.get_dataset_metadata"

    def test_reads_the_content_hash_and_the_tasks_of_the_version(self) -> None:
        metadata = DatasetMetadata(
            name="example-org/example-tasks",
            version=CONTENT_HASH,
            task_ids=[
                PackageTaskId(org="example-org", name=task.split("/")[1], ref=digest(task))
                for task in reversed(list(TRIALS))
            ],
        )
        with mock.patch(self.CLIENT, new=mock.AsyncMock(return_value=metadata)) as lookup:
            registry = resolve_registry_dataset(DATASET.identifier)
        lookup.assert_awaited_once_with(DATASET.identifier)
        self.assertEqual(registry, registry_of(TRIALS))

    def test_a_registry_failure_is_an_oracle_job_error(self) -> None:
        failure = mock.AsyncMock(side_effect=ValueError("Tag '1.2.0' not found"))
        with (
            mock.patch(self.CLIENT, new=failure),
            self.assertRaisesRegex(OracleJobError, "registry cannot resolve .*not found"),
        ):
            resolve_registry_dataset(DATASET.identifier)


class HarborShapeTest(OracleJobTestCase):
    """Harbor's own CLI builds the config and its models write the files, as `Job` does."""

    def oracle_command_config(self) -> JobConfig:
        """The JobConfig of the README's command, as Harbor's CLI builds it."""
        from harbor.cli.main import app
        from typer.testing import CliRunner

        built: list[JobConfig] = []
        argv = [
            "run",
            *("-d", DATASET.identifier, "-a", "oracle", "-e", "modal", "-k", "1"),
            *("-n", "16", "-r", "0", "-o", "jobs", "--job-name", "oracle-example"),
        ]
        execute = mock.patch(
            "harbor.cli.jobs._execute_job", side_effect=lambda config, **_: built.append(config)
        )
        with execute:
            outcome = CliRunner().invoke(app, argv)
        self.assertEqual(outcome.exit_code, 0, outcome.output)
        return built[0]

    def write_harbor_job(self, config: JobConfig) -> None:
        tasks = {"example-org/alpha": 1.0, "example-org/bravo": 0.0}
        self.job_dir.mkdir(parents=True)
        # `Job.create` resolves each package dataset before `Job.run` writes config.json, and the
        # resolution replaces the dataset's ref with the version's content hash.
        for dataset in config.datasets:
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
                task_name=task.split("/")[-1],
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
        self.evidence = Evidence(DATASET, PINS, DATASET.release_commit, registry_of(tasks))

    def harbor_check(self, config: JobConfig) -> str:
        self.write_harbor_job(config)
        return " ".join(self.check(self.evidence))

    def test_the_readme_command_has_no_problem_and_is_recorded(self) -> None:
        config = self.oracle_command_config()
        self.assertEqual(self.harbor_check(config), "")
        record = oracle_record(read_oracle_job(self.job_dir), self.evidence)
        self.assertEqual(
            record["command"],
            f"harbor run -d {DATASET.identifier} -a oracle -e modal -k 1 -n 16 -r 0 "
            "-o jobs --job-name oracle-example",
        )
        self.assertEqual(record["flags"]["nConcurrentTrials"], 16)
        self.assertEqual(record["dataset"]["contentHash"], CONTENT_HASH)
        self.assertEqual(record["job"]["wallClockSeconds"], 5400.0)
        self.assertEqual(
            record["harnessFlakyTasks"],
            [{"name": "example-org/bravo", "reward": 0.0, "exceptionType": None}],
        )

    def test_fields_that_change_the_job_are_refused(self) -> None:
        cases: dict[str, dict[str, Any]] = {
            "`verifier`": {"verifier": VerifierConfig(import_path="example:AlwaysOne")},
            "`environment.override_gpus`": {
                "environment": EnvironmentConfig(type="modal", override_gpus=0)
            },
            "`agents[0].override_timeout_sec`": {
                "agents": [AgentConfig(name="oracle", override_timeout_sec=60)]
            },
            "`agents[0].import_path`": {
                "agents": [AgentConfig(import_path="coding_agent_terminalbench.agent:CodingAgent")]
            },
            "`install_only`": {"install_only": True},
            "`n_attempts`": {"n_attempts": 2},
        }
        for expected, update in cases.items():
            with self.subTest(field=expected):
                self.remove_job()
                config = self.oracle_command_config().model_copy(update=update)
                self.assertIn(expected, self.harbor_check(config))

    def test_a_provider_key_of_the_user_agent_is_named(self) -> None:
        user_agent = UserAgentConfig(
            env={"OPENCODE_API_KEY": "${OPENCODE_API_KEY}"}, bridge=BridgeConfig(kind="acp")
        )
        config = self.oracle_command_config().model_copy(update={"user_agent": user_agent})
        problems = self.harbor_check(config)
        self.assertIn("`user_agent`", problems)
        self.assertIn("credential variable OPENCODE_API_KEY", problems)


class MainTest(OracleJobTestCase):
    def run_main(self, output: Path | None = None, **arguments: str) -> tuple[int, str, str]:
        output = output or self.root / "runs" / "oracle-example" / "oracle.json"
        values = {
            "--dataset": DATASET.identifier,
            "--source-repository": DATASET.source_repository,
            "--release-tag": DATASET.release_tag,
            "--release-commit": DATASET.release_commit,
            "--output": str(output),
            "--uv-lock": str(UV_LOCK),
            **arguments,
        }
        argv = [str(self.job_dir), *(item for pair in values.items() for item in pair)]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(argv, run=annotated_tag, resolve_dataset=lambda _: EVIDENCE.registry)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_writes_the_record_and_prints_the_flaky_tasks(self) -> None:
        write_job(self.job_dir, TRIALS)
        code, stdout, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn(f"Tasks: {len(TRIALS)}, harness-flaky: 2", stdout)
        self.assertIn("example-org/bravo: reward 0.0", stdout)
        self.assertIn("example-org/delta: no reward, EnvironmentStartTimeoutError", stdout)
        self.assertIn("Command: harbor run -d", stdout)
        record = json.loads((self.root / "runs" / "oracle-example" / "oracle.json").read_text())
        self.assertEqual(record["schemaVersion"], 1)
        self.assertEqual(len(record["harnessFlakyTasks"]), 2)

    def test_a_waived_release_tag_skips_the_resolution(self) -> None:
        write_job(self.job_dir, TRIALS)
        output = self.root / "runs" / "oracle-waived" / "oracle.json"
        calls: list[list[str]] = []

        def run(command: list[str]) -> str:
            calls.append(command)
            raise AssertionError("the tag was resolved although the waiver was given")

        argv = [
            str(self.job_dir),
            "--dataset", DATASET.identifier,
            "--source-repository", DATASET.source_repository,
            "--release-tag", DATASET.release_tag,
            "--release-commit", DATASET.release_commit,
            "--output", str(output),
            "--uv-lock", str(UV_LOCK),
            "--waive-release-tag", "the source repository publishes no tag",
        ]
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(argv, run=run, resolve_dataset=lambda _: EVIDENCE.registry)

        self.assertEqual(code, 0, stderr.getvalue())
        self.assertEqual(calls, [])
        record = json.loads(output.read_text())
        self.assertEqual(
            record["dataset"]["releaseCommitResolvedBy"],
            "recorded: the source repository publishes no tag",
        )

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

    def test_an_output_that_cannot_be_written_exits_2_and_leaves_no_file(self) -> None:
        write_job(self.job_dir, TRIALS)
        output = self.root / "runs" / "oracle.json"
        output.mkdir(parents=True)
        code, _, stderr = self.run_main(output)
        self.assertEqual(code, 2)
        self.assertIn("cannot write", stderr)
        self.assertEqual([path.name for path in output.parent.iterdir()], ["oracle.json"])

    def test_a_dataset_without_org_or_version_is_a_usage_error(self) -> None:
        for identifier in ("example-tasks@1.2.0", "example-org/example-tasks"):
            with self.subTest(identifier=identifier):
                argv = [str(self.job_dir), "--dataset", identifier, "--source-repository", "r"]
                argv += ["--release-tag", "t", "--release-commit", "c", "--output", "o.json"]
                stderr = io.StringIO()
                with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as exit:
                    main(argv, run=annotated_tag, resolve_dataset=lambda _: EVIDENCE.registry)
                self.assertEqual(exit.exception.code, 2)
                self.assertIn("org/name@version", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
