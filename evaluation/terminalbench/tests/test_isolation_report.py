"""The pass or fail decision of the credential isolation test (ADR 0001 §8, ADR 0005 §7), without
Docker or Harbor."""

import json
import unittest
from typing import Any

from coding_agent_terminalbench.isolation_report import (
    PATHS,
    PROC_MEM,
    Control,
    LauncherResult,
    Probe,
    Report,
    RunContext,
    SecretInResultError,
    ServerObservations,
    evaluate,
    render_result,
    result_document,
)


def denied() -> list[Probe]:
    """What a hardened artifact gives: no path reveals the key."""
    return [Probe(path=path, outcome="EACCES", found=False) for path in PATHS]


def readable() -> list[Control]:
    """What a working probe gives against a process that holds the key and is not hardened."""
    return [Control(path=path, found=True) for path in PATHS]


def rejected() -> LauncherResult:
    """A launcher that does not exec: the startup check refuses it before any session opens."""
    return LauncherResult(exit_code=2, message_matched=True, server_requests=0)


def served() -> ServerObservations:
    """The fake server got every Tool Result of the script, each request with the right key."""
    return ServerObservations(tool_results_received=4, expected_tool_results=4, key_matched=True)


def run(**changes: Any) -> Report:
    """A run in which everything holds, changed by `changes`."""
    inputs: dict[str, Any] = {
        "probes": denied(),
        "controls": readable(),
        "yama_ptrace_scope": None,
        "launcher": rejected(),
        "server": served(),
    }
    inputs.update(changes)
    return evaluate(**inputs)


def codes(report: Report) -> list[str]:
    return [failure.code for failure in report.failures]


class VerdictTest(unittest.TestCase):
    def test_the_test_passes_when_no_path_reveals_the_key_and_every_control_reads_it(self) -> None:
        report = run()

        self.assertTrue(report.passed)
        self.assertEqual(report.failures, [])

    def test_a_path_that_reveals_the_key_fails_the_test_and_is_named(self) -> None:
        for leaking in PATHS:
            with self.subTest(path=leaking):
                probes = [
                    Probe(path=path, outcome="read", found=True)
                    if path == leaking
                    else Probe(path=path, outcome="EACCES", found=False)
                    for path in PATHS
                ]

                report = run(probes=probes)

                self.assertFalse(report.passed)
                self.assertEqual(codes(report), ["KEY_FOUND"])
                self.assertIn(leaking, report.failures[0].message)

    def test_a_control_that_cannot_read_the_key_fails_the_test_even_when_every_probe_is_denied(
        self,
    ) -> None:
        for broken in PATHS:
            with self.subTest(path=broken):
                controls = [Control(path=path, found=path != broken) for path in PATHS]

                report = run(controls=controls)

                self.assertFalse(report.passed)
                self.assertEqual(codes(report), ["CONTROL_FAILED"])
                self.assertIn(broken, report.failures[0].message)

    def test_a_path_without_a_probe_result_fails_the_test_and_is_named(self) -> None:
        for missing in PATHS:
            with self.subTest(path=missing):
                probes = [probe for probe in denied() if probe.path != missing]

                report = run(probes=probes)

                self.assertFalse(report.passed)
                self.assertEqual(codes(report), ["PATH_NOT_TESTED"])
                self.assertIn(missing, report.failures[0].message)

    def test_an_outcome_that_shows_no_denial_does_not_count_as_a_denied_path(self) -> None:
        # The probe could not find the agent, the walk broke, or the error is not one that Linux
        # gives for a denied read. A silent probe like that must never pass as "the key is safe".
        for outcome in ("AGENT_NOT_FOUND", "INCOMPLETE", "ERROR", "ENOENT"):
            with self.subTest(outcome=outcome):
                probes = [
                    Probe(path=path, outcome=outcome, found=False) if path == PROC_MEM else probe
                    for path, probe in zip(PATHS, denied(), strict=True)
                ]

                report = run(probes=probes)

                self.assertFalse(report.passed)
                self.assertEqual(codes(report), ["PATH_NOT_TESTED"])
                self.assertIn(PROC_MEM, report.failures[0].message)
                self.assertIn(outcome, report.failures[0].message)

    def test_yama_that_denies_the_mem_control_makes_the_mem_path_not_demonstrable(self) -> None:
        # Yama's ptrace_scope 1 or more denies /proc/<pid>/mem of an ancestor whatever its
        # dumpability, so a denied probe there would prove nothing about the artifact.
        for scope in (1, 2, 3):
            with self.subTest(scope=scope):
                controls = [Control(path=path, found=path != PROC_MEM) for path in PATHS]

                report = run(controls=controls, yama_ptrace_scope=scope)

                self.assertFalse(report.passed)
                self.assertEqual(codes(report), ["MEM_NOT_DEMONSTRABLE"])
                self.assertIn(f"ptrace_scope is {scope}", report.failures[0].message)

    def test_a_launcher_that_keeps_its_shell_is_rejected_only_when_all_three_signs_hold(
        self,
    ) -> None:
        # Exit 2 alone is not enough: every configuration error exits with 2.
        cases = {
            "exit code 0": LauncherResult(exit_code=0, message_matched=True, server_requests=0),
            "exit code 70": LauncherResult(exit_code=70, message_matched=True, server_requests=0),
            "message": LauncherResult(exit_code=2, message_matched=False, server_requests=0),
            "requests": LauncherResult(exit_code=2, message_matched=True, server_requests=1),
        }
        for fragment, launcher in cases.items():
            with self.subTest(case=fragment):
                report = run(launcher=launcher)

                self.assertFalse(report.passed)
                self.assertEqual(codes(report), ["LAUNCHER_NOT_REJECTED"])
                self.assertIn(fragment, report.failures[0].message)

    def test_a_server_that_missed_a_tool_result_fails_the_test(self) -> None:
        server = ServerObservations(
            tool_results_received=3, expected_tool_results=4, key_matched=True
        )

        report = run(server=server)

        self.assertFalse(report.passed)
        self.assertEqual(codes(report), ["TOOL_RESULTS_MISSING"])
        self.assertIn("3 of 4", report.failures[0].message)
        self.assertNotIn("ANTHROPIC_BASE_URL", report.failures[0].message)

    def test_a_request_without_the_disposable_key_fails_the_test(self) -> None:
        # With no key in the agent's environment there would be nothing to hide, and every probe
        # would come back empty.
        server = ServerObservations(
            tool_results_received=4, expected_tool_results=4, key_matched=False
        )

        report = run(server=server)

        self.assertFalse(report.passed)
        self.assertEqual(codes(report), ["KEY_NOT_DELIVERED"])
        self.assertIn("x-api-key", report.failures[0].message)

    def test_a_server_that_got_nothing_says_the_artifact_may_not_follow_the_base_url(self) -> None:
        # The seam of the test is ANTHROPIC_BASE_URL. If the artifact ignores it, the Tool Calls
        # never ran, so every probe would stay silent and the test could not pass by showing that.
        server = ServerObservations(
            tool_results_received=0, expected_tool_results=4, key_matched=True
        )

        report = run(server=server)

        self.assertEqual(codes(report), ["TOOL_RESULTS_MISSING"])
        self.assertIn("0 of 4", report.failures[0].message)
        self.assertIn("ANTHROPIC_BASE_URL", report.failures[0].message)


CONTEXT = RunContext(
    coding_agent_version="0.0.1",
    coding_agent_commit="64128afd1c0f27db530cf167b015d206ef67c707",
    executable_sha256="a" * 64,
    dataset="example/dataset@1.0.0",
    task="example-task",
    backend="docker",
    uid=1000,
    user_name="agent",
)


def document(**changes: Any) -> dict[str, Any]:
    inputs: dict[str, Any] = {
        "context": CONTEXT,
        "probes": denied(),
        "controls": readable(),
        "yama_ptrace_scope": None,
        "launcher": rejected(),
        "server": served(),
    }
    inputs.update(changes)
    return result_document(**inputs)


class ResultDocumentTest(unittest.TestCase):
    def test_a_passing_run_is_described_by_one_stable_document(self) -> None:
        self.assertEqual(
            document(),
            {
                "schemaVersion": 1,
                "passed": True,
                "failures": [],
                "codingAgent": {
                    "version": "0.0.1",
                    "commit": "64128afd1c0f27db530cf167b015d206ef67c707",
                },
                "executableSha256": "a" * 64,
                "dataset": "example/dataset@1.0.0",
                "task": "example-task",
                "backend": "docker",
                "user": {"uid": 1000, "name": "agent"},
                "yamaPtraceScope": None,
                "probes": [
                    {"path": "inherited-environment", "outcome": "EACCES", "found": False},
                    {"path": "proc-environ", "outcome": "EACCES", "found": False},
                    {"path": "proc-mem", "outcome": "EACCES", "found": False},
                    {"path": "ancestors", "outcome": "EACCES", "found": False},
                ],
                "controls": [
                    {"path": "inherited-environment", "found": True},
                    {"path": "proc-environ", "found": True},
                    {"path": "proc-mem", "found": True},
                    {"path": "ancestors", "found": True},
                ],
                "launcherRejected": {"exitCode": 2, "messageMatched": True, "serverRequests": 0},
                "toolResultsReceived": 4,
            },
        )

    def test_a_failing_run_lists_each_failure_with_its_code_and_message(self) -> None:
        probes = (
            [Probe(path="proc-environ", outcome="read", found=True)] + denied()[:1] + denied()[2:]
        )

        result = document(probes=probes)

        self.assertFalse(result["passed"])
        self.assertEqual(
            result["failures"],
            [
                {
                    "code": "KEY_FOUND",
                    "message": "a Tool Call found the key through proc-environ",
                }
            ],
        )


DISPOSABLE_KEY = "sk-ant-isolation-test-0123456789abcdef0123456789abcdef"


class RenderTest(unittest.TestCase):
    def test_the_text_is_the_document_as_json_with_a_final_newline(self) -> None:
        text = render_result(document(), secret=DISPOSABLE_KEY)

        self.assertTrue(text.endswith("}\n"))
        self.assertEqual(json.loads(text), document())

    def test_a_result_that_holds_the_disposable_key_is_never_rendered(self) -> None:
        # A probe reports an outcome and a flag. If a value got in anyway, printing the result
        # would copy it into a file that a person attaches to a manifest.
        leaking = [Probe(path="proc-environ", outcome=DISPOSABLE_KEY, found=True)] + denied()[2:]

        with self.assertRaises(SecretInResultError) as raised:
            render_result(document(probes=leaking), secret=DISPOSABLE_KEY)

        self.assertNotIn(DISPOSABLE_KEY, str(raised.exception))


if __name__ == "__main__":
    unittest.main()
