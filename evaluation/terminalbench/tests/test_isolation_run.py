"""The run of the credential isolation test against a task container that this file scripts.

The container answers the commands that the test sends, the way a hardened artifact and a launcher
would. For the agent it makes the HTTP requests that the Anthropic SDK makes, to the fake model
server that the test starts on the host. No Docker and no Harbor are involved.
"""

import asyncio
import json
import unittest
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.install import INSTALLED_EXECUTABLE
from coding_agent_terminalbench.isolation_run import (
    IsolationRunError,
    IsolationSetup,
    run_isolation_test,
)

from tests.support import ExecOutcome

COMMIT = "64128afd1c0f27db530cf167b015d206ef67c707"
SHA256 = "b" * 64
KEY = "sk-ant-isolation-test-0123456789abcdef0123456789abcdef"

REFUSAL = (
    "coding-agent: --approval-policy auto-approve refused: ancestor process 7 (sh) holds "
    "ANTHROPIC_API_KEY, which a Tool Call could read; start Coding Agent with exec so that no "
    "process above it keeps the credential\n"
)


def probe_lines(*rows: tuple[str, str, bool]) -> str:
    return "".join(
        json.dumps({"path": path, "outcome": outcome, "found": found}, separators=(",", ":")) + "\n"
        for path, outcome, found in rows
    )


# What the probe prints when the artifact keeps the key from a Tool Call.
HARDENED_OUTPUT = (
    probe_lines(
        ("inherited-environment", "read", False),
        ("proc-environ", "EACCES", False),
        ("proc-mem", "EACCES", False),
        ("ancestors", "read", False),
    )
    + "[exit code: 0]"
)

# What the same probe prints against a process that holds the key and is not hardened.
CONTROL_OUTPUT = probe_lines(
    ("inherited-environment", "read", True),
    ("proc-environ", "read", True),
    ("proc-mem", "read", True),
    ("ancestors", "read", True),
)


@dataclass
class Call:
    command: str
    env: dict[str, str]
    user: str | int | None


@dataclass
class ScriptedContainer:
    """A task container with the artifact installed. `probe_output` is what the Tool Call prints."""

    probe_output: str = HARDENED_OUTPUT
    launcher_result: ExecOutcome = field(
        default_factory=lambda: ExecOutcome(return_code=2, stderr=REFUSAL)
    )
    # False: the agent never contacts the server, as an artifact that ignores ANTHROPIC_BASE_URL.
    plays_agent: bool = True
    control_output: str = CONTROL_OUTPUT
    calls: list[Call] = field(default_factory=list)
    uploads: dict[str, bytes] = field(default_factory=dict)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self.uploads[target_path] = Path(source_path).read_bytes()

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecOutcome:
        self.calls.append(Call(command, dict(env or {}), user))
        if command == f"{INSTALLED_EXECUTABLE} --version":
            return ExecOutcome(stdout=f"coding-agent 0.0.1 {COMMIT}\n")
        if command == f"sha256sum {INSTALLED_EXECUTABLE}":
            return ExecOutcome(stdout=f"{SHA256}  {INSTALLED_EXECUTABLE}\n")
        if command == "id -u":
            return ExecOutcome(stdout="1000\n")
        if command == "id -un":
            return ExecOutcome(stdout="agent\n")
        if command.startswith("cat /proc/sys/kernel/yama/ptrace_scope"):
            return ExecOutcome(return_code=1)  # Yama is not loaded, as in Docker Desktop's kernel
        if command.startswith(f"exec {INSTALLED_EXECUTABLE} run"):
            if self.plays_agent:
                await asyncio.to_thread(self._play_the_agent, env or {})
            return ExecOutcome()
        if command.startswith("sh -c '\"$@\"; exit $?' sh"):
            return self.launcher_result
        if command.startswith("sh -c 'sh /tmp/isolation-probe.sh"):
            return ExecOutcome(stdout=self.control_output)
        return ExecOutcome()

    def _play_the_agent(self, env: dict[str, str]) -> None:
        """Two requests, as the agent sends: the task, then the history with the Tool Result."""
        base = env["ANTHROPIC_BASE_URL"]
        task = {"role": "user", "content": "task"}
        asked = {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "toolu_1", "name": "bash", "input": {}}],
        }
        answered = {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": self.probe_output}
            ],
        }
        for messages in ([task], [task, asked, answered]):
            request = urllib.request.Request(
                f"{base}/v1/messages",
                data=json.dumps({"messages": messages, "stream": True}).encode(),
                headers={"content-type": "application/json", "x-api-key": env["ANTHROPIC_API_KEY"]},
                method="POST",
            )
            urllib.request.urlopen(request).read()


SETUP = IsolationSetup(
    dataset="example/dataset@1.0.0",
    task="example-task",
    backend="docker",
    key=KEY,
    container_host="127.0.0.1",
)


def run(
    container: ScriptedContainer, log: Callable[[str], None] = lambda _: None
) -> dict[str, Any]:
    return asyncio.run(run_isolation_test(container, SETUP, log))


class RunTest(unittest.TestCase):
    def test_a_hardened_artifact_passes_and_the_result_names_the_run(self) -> None:
        result = run(ScriptedContainer())

        self.assertEqual(result["failures"], [])
        self.assertTrue(result["passed"])
        self.assertEqual(result["codingAgent"], {"version": "0.0.1", "commit": COMMIT})
        self.assertEqual(result["executableSha256"], SHA256)
        self.assertEqual(result["dataset"], "example/dataset@1.0.0")
        self.assertEqual(result["task"], "example-task")
        self.assertEqual(result["backend"], "docker")
        self.assertEqual(result["user"], {"uid": 1000, "name": "agent"})
        self.assertIsNone(result["yamaPtraceScope"])
        self.assertEqual(result["launcherRejected"]["exitCode"], 2)
        self.assertEqual(result["toolResultsReceived"], 1)

    def test_a_leak_that_the_probe_reports_in_the_tool_result_fails_the_test(self) -> None:
        leaking = probe_lines(
            ("inherited-environment", "read", False),
            ("proc-environ", "read", True),
            ("proc-mem", "EACCES", False),
            ("ancestors", "read", False),
        )

        result = run(ScriptedContainer(probe_output=leaking))

        self.assertFalse(result["passed"])
        self.assertEqual([f["code"] for f in result["failures"]], ["KEY_FOUND"])
        self.assertIn("proc-environ", result["failures"][0]["message"])

    def test_a_control_run_that_prints_nothing_fails_every_path(self) -> None:
        result = run(ScriptedContainer(control_output=""))

        self.assertFalse(result["passed"])
        self.assertEqual([f["code"] for f in result["failures"]], ["CONTROL_FAILED"] * 4)

    def test_a_launcher_that_keeps_its_shell_and_is_not_refused_fails_the_test(self) -> None:
        container = ScriptedContainer(launcher_result=ExecOutcome(return_code=0))

        result = run(container)

        self.assertFalse(result["passed"])
        self.assertEqual([f["code"] for f in result["failures"]], ["LAUNCHER_NOT_REJECTED"])

    def test_the_refusal_is_found_when_the_backend_merges_standard_error_into_output(self) -> None:
        # Harbor's Docker environment runs `docker compose exec` with stderr sent to stdout, so
        # the refusal arrives in `stdout` and `stderr` is empty.
        merged = ExecOutcome(return_code=2, stdout=REFUSAL, stderr=None)

        result = run(ScriptedContainer(launcher_result=merged))

        self.assertEqual(result["failures"], [])
        self.assertTrue(result["launcherRejected"]["messageMatched"])

    def test_a_refusal_that_does_not_match_is_logged_without_the_key(self) -> None:
        other = ExecOutcome(
            return_code=2, stderr=f"coding-agent: --model is not known; key {KEY}\n"
        )
        lines: list[str] = []

        result = run(ScriptedContainer(launcher_result=other), log=lines.append)

        self.assertFalse(result["launcherRejected"]["messageMatched"])
        self.assertEqual(len(lines), 1)
        self.assertIn("--model is not known", lines[0])
        self.assertIn("[redacted]", lines[0])
        self.assertNotIn(KEY, lines[0])

    def test_an_agent_that_never_reaches_the_server_fails_and_names_the_base_url(self) -> None:
        result = run(ScriptedContainer(plays_agent=False))

        self.assertFalse(result["passed"])
        codes = [f["code"] for f in result["failures"]]
        # With no Tool Result there is no probe result either, on any path.
        self.assertIn("TOOL_RESULTS_MISSING", codes)
        self.assertIn("PATH_NOT_TESTED", codes)
        missing = next(f for f in result["failures"] if f["code"] == "TOOL_RESULTS_MISSING")
        self.assertIn("ANTHROPIC_BASE_URL", missing["message"])

    def test_the_agent_runs_as_the_user_harbor_runs_it_with_only_the_disposable_key(self) -> None:
        container = ScriptedContainer()

        run(container)

        runs = [c for c in container.calls if "/installed-agent/coding-agent run" in c.command]
        self.assertEqual(len(runs), 2)  # the launcher that keeps its shell, and the one with exec
        for call in runs:
            # No `user=`: Harbor's default user for the task, not one that the test picked.
            self.assertIsNone(call.user)
            self.assertEqual(set(call.env), {"ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"})
            self.assertEqual(call.env["ANTHROPIC_API_KEY"], KEY)
        job_command = next(c.command for c in runs if c.command.startswith("exec "))
        self.assertIn("--approval-policy auto-approve", job_command)
        self.assertIn("--provider anthropic", job_command)
        self.assertNotIn("|", job_command)

    def test_the_launcher_that_keeps_its_shell_runs_the_command_of_the_job_without_exec(
        self,
    ) -> None:
        container = ScriptedContainer()

        run(container)

        job = next(c.command for c in container.calls if c.command.startswith("exec "))
        kept = next(c.command for c in container.calls if c.command.startswith('sh -c \'"$@"'))
        self.assertEqual(kept, "sh -c '\"$@\"; exit $?' sh " + job.removeprefix("exec "))

    def test_the_key_is_in_no_command_and_only_the_probe_file_holds_it(self) -> None:
        container = ScriptedContainer()

        run(container)

        self.assertEqual([c for c in container.calls if KEY in c.command], [])
        self.assertEqual(
            sorted(
                target for target, content in container.uploads.items() if KEY.encode() in content
            ),
            ["/tmp/isolation-probe.sh"],
        )

    def test_a_version_line_that_is_not_the_agents_stops_the_run(self) -> None:
        class WrongVersion(ScriptedContainer):
            async def exec(self, command: str, *args: Any, **kwargs: Any) -> ExecOutcome:
                if command.endswith("--version"):
                    return ExecOutcome(stdout="something else\n")
                return await super().exec(command, *args, **kwargs)

        with self.assertRaises(IsolationRunError):
            run(WrongVersion())


if __name__ == "__main__":
    unittest.main()
