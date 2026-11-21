"""The command line of the credential isolation test (ADR 0005 §7), without Docker or Harbor."""

import asyncio
import io
import json
import re
import unittest
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.isolation_run import IsolationRunError
from coding_agent_terminalbench.isolation_test import (
    Arguments,
    UsageError,
    main,
    new_disposable_key,
    parse_arguments,
    started,
)

SOURCE = Path(__file__).resolve().parents[1] / "src" / "coding_agent_terminalbench"

REQUIRED = ["--dataset", "example/dataset@1.0.0", "--task", "example-task", "--artifact-dir", "out"]


def passing() -> dict[str, Any]:
    return {"passed": True, "failures": [], "probes": [{}, {}, {}, {}], "user": {"uid": 1000}}


def failing() -> dict[str, Any]:
    return {
        "passed": False,
        "failures": [
            {"code": "KEY_FOUND", "message": "a Tool Call found the key through proc-mem"},
            {"code": "LAUNCHER_NOT_REJECTED", "message": "it ended with exit code 0, not 2"},
        ],
        "probes": [{}, {}, {}, {}],
        "user": {"uid": 0},
    }


def run_main(argv: list[str], document: dict[str, Any] | Exception) -> tuple[int, str, str]:
    """Runs `main` with a stand-in for the container run, and returns the code and both streams."""
    stdout, stderr = io.StringIO(), io.StringIO()

    async def stand_in(arguments: Arguments, key: str) -> dict[str, Any]:
        if isinstance(document, Exception):
            raise document
        return document

    code = main(argv, run=stand_in, stdout=stdout, stderr=stderr)
    return code, stdout.getvalue(), stderr.getvalue()


class ArgumentsTest(unittest.TestCase):
    def test_the_dataset_and_the_task_and_the_artifact_are_required(self) -> None:
        for name in ("--dataset", "--task", "--artifact-dir"):
            with self.subTest(missing=name):
                argv = list(REQUIRED)
                index = argv.index(name)
                del argv[index : index + 2]

                with self.assertRaisesRegex(UsageError, re.escape(name)):
                    parse_arguments(argv)

    def test_a_dataset_must_be_a_registry_name_with_a_version(self) -> None:
        for dataset in ("example/dataset", "latest", "example/dataset@latest", "./local", "/tmp/x"):
            with self.subTest(dataset=dataset):
                argv = ["--dataset", dataset, "--task", "t", "--artifact-dir", "out"]

                with self.assertRaisesRegex(UsageError, "--dataset"):
                    parse_arguments(argv)

    def test_the_arguments_carry_the_defaults_that_the_docker_run_needs(self) -> None:
        arguments = parse_arguments(REQUIRED)

        self.assertEqual(arguments.dataset, "example/dataset@1.0.0")
        self.assertEqual(arguments.task, "example-task")
        self.assertEqual(arguments.artifact_dir, Path("out"))
        self.assertEqual(arguments.container_host, "host.docker.internal")
        self.assertIsNone(arguments.output)


class MainTest(unittest.TestCase):
    def test_a_passing_run_prints_only_the_json_on_stdout_and_exits_with_0(self) -> None:
        code, stdout, stderr = run_main(REQUIRED, passing())

        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout), passing())
        self.assertTrue(stderr.startswith("PASS"))
        self.assertEqual(len(stderr.splitlines()), 1)

    def test_a_failing_run_exits_with_1_and_the_summary_names_each_failure(self) -> None:
        code, stdout, stderr = run_main(REQUIRED, failing())

        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stdout)["passed"], False)
        self.assertTrue(stderr.startswith("FAIL"))
        self.assertIn("KEY_FOUND", stderr)
        self.assertIn("LAUNCHER_NOT_REJECTED", stderr)

    def test_a_run_that_shows_nothing_about_the_artifact_exits_with_2_not_1(self) -> None:
        # Exit 1 means the artifact failed. A run whose every failure says only that the test
        # proved nothing on this host or image, such as Yama denying the mem control, must not
        # look like a leak to whoever reads the exit code.
        for code in (
            "MEM_NOT_DEMONSTRABLE",
            "CONTROL_FAILED",
            "PATH_NOT_TESTED",
            "TOOL_RESULTS_MISSING",
            "KEY_NOT_DELIVERED",
        ):
            with self.subTest(code=code):
                document = {**failing(), "failures": [{"code": code, "message": "m"}]}

                exit_code, stdout, stderr = run_main(REQUIRED, document)

                self.assertEqual(exit_code, 2)
                self.assertEqual(json.loads(stdout)["passed"], False)
                self.assertTrue(stderr.startswith("INCONCLUSIVE"))
                self.assertIn(code, stderr)

    def test_a_leak_next_to_an_inconclusive_path_still_exits_with_1(self) -> None:
        failures = [
            {"code": "KEY_FOUND", "message": "a Tool Call found the key through proc-environ"},
            {"code": "MEM_NOT_DEMONSTRABLE", "message": "m"},
        ]

        exit_code, _, stderr = run_main(REQUIRED, {**failing(), "failures": failures})

        self.assertEqual(exit_code, 1)
        self.assertTrue(stderr.startswith("FAIL"))

    def test_a_run_that_cannot_start_exits_with_2_and_prints_no_result(self) -> None:
        code, stdout, stderr = run_main(REQUIRED, IsolationRunError("Docker is not running"))

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("Docker is not running", stderr)

    def test_any_other_error_during_the_run_exits_with_2_not_as_a_failed_artifact(self) -> None:
        # Exit 1 means the artifact failed. A broken download, a container that answers oddly or a
        # bug in the test says nothing about the artifact, so it must not exit 1.
        code, stdout, stderr = run_main(REQUIRED, RuntimeError("the task download failed"))

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("RuntimeError", stderr)
        self.assertIn("the task download failed", stderr)
        self.assertNotIn("Traceback", stderr)

    def test_an_error_message_never_prints_the_disposable_key(self) -> None:
        stdout, stderr = io.StringIO(), io.StringIO()

        async def leaks(arguments: Arguments, key: str) -> dict[str, Any]:
            raise RuntimeError(f"the container echoed {key}")

        code = main(REQUIRED, run=leaks, stdout=stdout, stderr=stderr)

        self.assertEqual(code, 2)
        self.assertNotRegex(stderr.getvalue(), r"sk-ant-isolation-test-[0-9a-f]{32}")
        self.assertIn("[redacted]", stderr.getvalue())

    def test_a_usage_error_exits_with_2_and_prints_no_result(self) -> None:
        code, stdout, stderr = run_main(["--task", "t"], passing())

        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("--dataset", stderr)

    def test_the_output_option_writes_the_same_json_to_a_file(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result.json"

            code, stdout, _ = run_main([*REQUIRED, "--output", str(target)], passing())

            self.assertEqual(code, 0)
            self.assertEqual(target.read_text(), stdout)


class Environment:
    """A Harbor environment that records start and stop, and fails where a test says."""

    def __init__(self, start_error: Exception | None = None, stop_error: Exception | None = None):
        self.start_error = start_error
        self.stop_error = stop_error
        self.stopped_with: list[bool] = []

    async def start(self, force_build: bool) -> None:
        if self.start_error is not None:
            raise self.start_error

    async def stop(self, delete: bool) -> None:
        self.stopped_with.append(delete)
        if self.stop_error is not None:
            raise self.stop_error


def use(environment: Environment, body_error: Exception | None = None) -> list[str]:
    """Runs a body inside `started`. Returns what it logged."""
    lines: list[str] = []

    async def go() -> None:
        async with started(environment, "example-task", lines.append):
            if body_error is not None:
                raise body_error

    asyncio.run(go())
    return lines


class StartedTest(unittest.TestCase):
    def test_the_environment_is_stopped_and_deleted_after_the_run(self) -> None:
        environment = Environment()

        use(environment)

        self.assertEqual(environment.stopped_with, [True])

    def test_a_start_that_fails_halfway_still_deletes_what_it_made(self) -> None:
        # Docker can have made a container and a network before a healthcheck times out.
        environment = Environment(start_error=RuntimeError("healthcheck timed out"))

        with self.assertRaisesRegex(
            IsolationRunError, "cannot start the container of example-task"
        ):
            use(environment)

        self.assertEqual(environment.stopped_with, [True])

    def test_a_stop_that_fails_does_not_hide_why_the_start_failed(self) -> None:
        environment = Environment(
            start_error=RuntimeError("healthcheck timed out"),
            stop_error=RuntimeError("no such project"),
        )

        with self.assertRaisesRegex(IsolationRunError, "healthcheck timed out"):
            use(environment)

        self.assertEqual(environment.stopped_with, [True])

    def test_a_stop_that_fails_is_logged(self) -> None:
        lines = use(Environment(stop_error=RuntimeError("no such project")))

        self.assertEqual(len(lines), 1)
        self.assertIn("no such project", lines[0])

    def test_a_run_that_fails_still_stops_the_environment(self) -> None:
        environment = Environment()

        with self.assertRaises(ValueError):
            use(environment, body_error=ValueError("the run broke"))

        self.assertEqual(environment.stopped_with, [True])


class DisposableKeyTest(unittest.TestCase):
    def test_the_key_is_clearly_fake_and_new_every_time(self) -> None:
        first, second = new_disposable_key(), new_disposable_key()

        self.assertRegex(first, r"^sk-ant-isolation-test-[0-9a-f]{32}$")
        self.assertNotEqual(first, second)

    def test_the_test_never_reads_the_environment_of_the_host(self) -> None:
        # The key is made here and passed down. A real key in the host's environment must not be
        # able to reach a task container through this test (ADR 0005 §6, the task of CDA-92).
        for module in ("isolation_run", "isolation_test", "isolation_probe", "isolation_server"):
            with self.subTest(module=module):
                text = (SOURCE / f"{module}.py").read_text()

                self.assertNotRegex(text, r"os\.environ|getenv")


if __name__ == "__main__":
    unittest.main()
