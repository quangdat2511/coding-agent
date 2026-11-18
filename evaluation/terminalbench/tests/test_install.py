import asyncio
import hashlib
import tempfile
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from harbor.agents.factory import AgentFactory
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext

from coding_agent_terminalbench.agent import CodingAgent
from coding_agent_terminalbench.install import (
    INSTALLED_EXECUTABLE,
    ArtifactInstallError,
)
from coding_agent_terminalbench.manifest import parse_manifest
from tests.support import (
    COMMIT,
    manifest_data,
    write_artifact,
    write_manifest,
    write_run_files,
)

IMPORT_PATH = "coding_agent_terminalbench.agent:CodingAgent"
VERSION_LINE = f"coding-agent 0.0.1 {COMMIT}"


@dataclass
class Exec:
    command: str
    user: str | int | None


@dataclass
class Upload:
    source: Path
    target: str
    content: bytes


@dataclass
class FakeEnvironment:
    """A task container that answers the commands that `setup()` sends, and records them.

    `user=None` means the environment's `default_user`, the user Harbor runs the agent as.
    """

    machine: str = "x86_64"
    uname_return_code: int = 0
    has_sha256sum: bool = True
    # The bytes that arrive in the container differ from the ones the host sent.
    damage_upload: bool = False
    has_bash: bool = True
    package_manager: str = "apt-get"
    version_stdout: str = f"{VERSION_LINE}\n"
    version_return_code: int = 0
    default_user: str | int | None = "agent"
    calls: list[Exec | Upload] = field(default_factory=list)
    installed: list[str] = field(default_factory=list)

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
        **_: Any,
    ) -> ExecResult:
        self.calls.append(Exec(command, user))
        # Harbor's exec helpers prefix this, and it changes nothing here.
        command = command.removeprefix("set -o pipefail; ")
        if command == "[ -d /installed-agent ] || mkdir -p /installed-agent":
            return ExecResult(return_code=0)
        if command == "uname -m":
            return ExecResult(stdout=f"{self.machine}\n", return_code=self.uname_return_code)
        if command.startswith("command -v bash"):
            return ExecResult(return_code=0 if self.has_bash else 1)
        if command.startswith("for manager in"):
            return ExecResult(stdout=self.package_manager, return_code=0)
        if command.startswith("apt-get update && apt-get install -y "):
            self.installed.append(command.removeprefix("apt-get update && apt-get install -y "))
            self.has_bash = True
            return ExecResult(return_code=0)
        if command == f"sha256sum {INSTALLED_EXECUTABLE}":
            if not self.has_sha256sum:
                return ExecResult(stderr="bash: sha256sum: command not found", return_code=127)
            [upload] = self.uploads()
            content = upload.content + (b"\0" if self.damage_upload else b"")
            digest = hashlib.sha256(content).hexdigest()
            return ExecResult(stdout=f"{digest}  {INSTALLED_EXECUTABLE}\n", return_code=0)
        if command == f"chmod 0755 {INSTALLED_EXECUTABLE}":
            return ExecResult(return_code=0)
        if command == f"{INSTALLED_EXECUTABLE} --version":
            return ExecResult(stdout=self.version_stdout, return_code=self.version_return_code)
        raise AssertionError(f"unexpected command: {command!r}")

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        source = Path(source_path)
        self.calls.append(Upload(source, target_path, source.read_bytes()))

    def uploads(self) -> list[Upload]:
        return [call for call in self.calls if isinstance(call, Upload)]

    def commands(self) -> list[str]:
        return [call.command for call in self.calls if isinstance(call, Exec)]


class InstallTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.artifact_dir = self.root / "artifact"
        self.data = write_artifact(self.artifact_dir)

    def create(self) -> CodingAgent:
        agent = AgentFactory.create_agent_from_import_path(
            IMPORT_PATH,
            logs_dir=self.root / "logs",
            model_name="opencode/some-model",
            artifact_dir=str(self.artifact_dir),
        )
        assert isinstance(agent, CodingAgent)
        return agent

    def setup_agent(self, environment: FakeEnvironment) -> CodingAgent:
        """Runs Harbor's `setup()`, which calls `install()`, as a trial does."""
        agent = self.create()
        asyncio.run(agent.setup(environment))  # type: ignore[arg-type]
        return agent

    def assert_setup_fails(self, environment: FakeEnvironment, message: str) -> None:
        agent = self.create()
        with self.assertRaisesRegex(ArtifactInstallError, message):
            asyncio.run(agent.setup(environment))  # type: ignore[arg-type]
        self.assertIsNone(agent.installed_executable)

    def write_executable(self, file: str, content: bytes) -> None:
        (self.artifact_dir / file).write_bytes(content)

    # Architecture selection.

    def test_an_x86_64_container_gets_the_x64_executable(self) -> None:
        environment = FakeEnvironment(machine="x86_64")
        agent = self.setup_agent(environment)
        [upload] = environment.uploads()
        self.assertEqual(upload.target, INSTALLED_EXECUTABLE)
        self.assertEqual(upload.source.name, "coding-agent-linux-x64")
        self.assertEqual(upload.content, b"fake bun-linux-x64-baseline executable\n")
        assert agent.installed_executable is not None
        self.assertEqual(agent.installed_executable.target, "bun-linux-x64-baseline")

    def test_an_aarch64_container_gets_the_arm64_executable(self) -> None:
        environment = FakeEnvironment(machine="aarch64")
        agent = self.setup_agent(environment)
        [upload] = environment.uploads()
        self.assertEqual(upload.source.name, "coding-agent-linux-arm64")
        assert agent.installed_executable is not None
        self.assertEqual(agent.installed_executable.target, "bun-linux-arm64")

    def test_another_architecture_fails_setup_before_any_upload(self) -> None:
        for machine in ("armv7l", "riscv64", "i686", "arm64", "X86_64"):
            with self.subTest(machine=machine):
                environment = FakeEnvironment(machine=machine)
                self.assert_setup_fails(
                    environment,
                    f"architecture is '{machine}'; the artifact supports only aarch64, x86_64",
                )
                self.assertEqual(environment.uploads(), [])

    def test_an_unreadable_architecture_fails_setup(self) -> None:
        self.assert_setup_fails(
            FakeEnvironment(machine=""),
            "cannot read the task container's architecture: `uname -m` printed nothing",
        )
        self.assert_setup_fails(
            FakeEnvironment(uname_return_code=1),
            "cannot read the task container's architecture: `uname -m` exited 1 with stderr ''$",
        )

    def test_a_container_without_bash_fails_at_uname_and_names_bash(self) -> None:
        # Docker and Modal run every command through `bash -c`, so the first command already
        # fails: 126 when bash cannot run, 127 when it is not found.
        for code in (126, 127):
            with self.subTest(code=code):
                environment = FakeEnvironment(uname_return_code=code)
                self.assert_setup_fails(
                    environment,
                    f"`uname -m` exited {code} .*Harbor runs every command through bash, so the "
                    "image may have no bash",
                )
                self.assertEqual(environment.uploads(), [])

    def test_a_manifest_without_the_architecture_fails_setup(self) -> None:
        self.data["executables"] = [
            entry for entry in self.data["executables"] if entry["target"] != "bun-linux-arm64"
        ]
        write_manifest(self.artifact_dir, self.data)
        environment = FakeEnvironment(machine="aarch64")
        self.assert_setup_fails(
            environment, "exactly one executable for bun-linux-arm64 .architecture aarch64., found 0"
        )
        self.assertEqual(environment.uploads(), [])

    # SHA-256 check on the host.

    def test_a_changed_executable_fails_setup_before_any_upload(self) -> None:
        self.write_executable("coding-agent-linux-x64", b"a different build\n")
        environment = FakeEnvironment()
        changed = hashlib.sha256(b"a different build\n").hexdigest()
        expected = self.data["executables"][0]["sha256"]
        self.assert_setup_fails(
            environment,
            f"SHA-256 of .*coding-agent-linux-x64 is {changed}, but artifact-manifest.json "
            f"records {expected}",
        )
        self.assertEqual(environment.uploads(), [])

    def test_only_the_selected_executable_is_hashed(self) -> None:
        # A broken arm64 file does not stop an x86_64 trial.
        self.write_executable("coding-agent-linux-arm64", b"a different build\n")
        self.setup_agent(FakeEnvironment(machine="x86_64"))

    def test_a_missing_executable_fails_setup(self) -> None:
        (self.artifact_dir / "coding-agent-linux-x64").unlink()
        environment = FakeEnvironment()
        self.assert_setup_fails(environment, "coding-agent-linux-x64 does not exist")
        self.assertEqual(environment.uploads(), [])

    # SHA-256 check in the container.

    def test_the_uploaded_bytes_are_hashed_in_the_container_before_they_run(self) -> None:
        environment = FakeEnvironment()
        self.setup_agent(environment)
        commands = [command.removeprefix("set -o pipefail; ") for command in environment.commands()]
        self.assertLess(
            commands.index(f"sha256sum {INSTALLED_EXECUTABLE}"),
            commands.index(f"{INSTALLED_EXECUTABLE} --version"),
        )

    def test_a_damaged_upload_fails_setup(self) -> None:
        environment = FakeEnvironment(damage_upload=True)
        expected = self.data["executables"][0]["sha256"]
        self.assert_setup_fails(
            environment,
            f"SHA-256 of {INSTALLED_EXECUTABLE} in the task container is '[0-9a-f]{{64}}', but "
            f"artifact-manifest.json records {expected} for coding-agent-linux-x64",
        )
        self.assertNotIn(f"{INSTALLED_EXECUTABLE} --version", environment.commands())

    def test_a_container_without_sha256sum_keeps_the_host_check(self) -> None:
        environment = FakeEnvironment(has_sha256sum=False)
        agent = self.create()
        with self.assertLogs(agent.logger, level="WARNING") as captured:
            asyncio.run(agent.setup(environment))  # type: ignore[arg-type]
        self.assertIn("has no sha256sum", captured.output[0])
        self.assertIsNotNone(agent.installed_executable)

    # Upload and permissions.

    def test_root_makes_the_upload_executable_before_the_agent_user_runs_it(self) -> None:
        environment = FakeEnvironment()
        self.setup_agent(environment)
        steps = [
            (call.command.removeprefix("set -o pipefail; "), call.user)
            if isinstance(call, Exec)
            else ("upload", call.target)
            for call in environment.calls
        ]
        upload = steps.index(("upload", INSTALLED_EXECUTABLE))
        chmod = steps.index((f"chmod 0755 {INSTALLED_EXECUTABLE}", "root"))
        # user=None is the environment's default user, the user Harbor runs the agent as.
        version = steps.index((f"{INSTALLED_EXECUTABLE} --version", None))
        self.assertLess(upload, chmod)
        self.assertLess(chmod, version)

    # bash.

    def test_present_bash_installs_nothing(self) -> None:
        environment = FakeEnvironment(has_bash=True)
        self.setup_agent(environment)
        self.assertEqual(environment.installed, [])
        # One check finds bash, so Harbor's helper never runs and looks for no package manager.
        self.assertEqual(
            [command for command in environment.commands() if command.startswith("command -v")],
            ["command -v bash >/dev/null 2>&1"],
        )
        self.assertFalse(
            any(command.startswith("for manager in") for command in environment.commands())
        )

    def test_missing_bash_installs_bash_and_nothing_else(self) -> None:
        environment = FakeEnvironment(has_bash=False)
        self.setup_agent(environment)
        self.assertEqual(environment.installed, ["bash"])

    def test_missing_bash_without_a_package_manager_fails_setup(self) -> None:
        environment = FakeEnvironment(has_bash=False, package_manager="")
        self.assert_setup_fails(environment, "the task container has no bash")

    # --version.

    def test_a_different_version_fails_setup(self) -> None:
        environment = FakeEnvironment(version_stdout="coding-agent 0.0.2 deadbeef\n")
        self.assert_setup_fails(
            environment,
            f"--version printed 'coding-agent 0.0.2 deadbeef', but artifact-manifest.json "
            f"names '{VERSION_LINE}'",
        )

    def test_a_dirty_build_must_print_its_dirty_commit(self) -> None:
        self.data["codingAgent"] = {"version": "0.0.1", "commit": f"{COMMIT}-dirty"}
        self.data["dirty"] = True
        write_manifest(self.artifact_dir, self.data)
        self.assert_setup_fails(FakeEnvironment(), "--version printed")
        self.setup_agent(FakeEnvironment(version_stdout=f"{VERSION_LINE}-dirty\n"))

    def test_extra_output_fails_setup(self) -> None:
        self.assert_setup_fails(
            FakeEnvironment(version_stdout=f"warning: something\n{VERSION_LINE}\n"),
            "--version printed",
        )

    def test_a_failing_version_command_fails_setup(self) -> None:
        self.assert_setup_fails(
            FakeEnvironment(version_return_code=126, version_stdout=""),
            "--version exited 126",
        )

    def test_a_version_command_that_cannot_start_names_glibc(self) -> None:
        # A glibc executable on a musl image: the shell cannot start it and exits 127.
        self.assert_setup_fails(
            FakeEnvironment(version_return_code=127, version_stdout=""),
            "--version exited 127 .*needs glibc 2.17 or newer.*Alpine",
        )
        # Other exit codes get no glibc hint.
        self.assert_setup_fails(
            FakeEnvironment(version_return_code=126, version_stdout=""),
            "exited 126 with stderr ''$",
        )

    def test_the_reported_version_names_the_build_that_ran(self) -> None:
        agent = self.setup_agent(FakeEnvironment())
        self.assertEqual(agent.version(), f"0.0.1 {COMMIT}")
        self.assertEqual(agent.to_agent_info().version, f"0.0.1 {COMMIT}")
        assert agent.installed_executable is not None
        self.assertEqual(agent.installed_executable.sha256, self.data["executables"][0]["sha256"])

    def test_the_trial_metadata_names_the_installed_executable(self) -> None:
        # Both builds print the same version line, so only this field says which one ran.
        agent = self.setup_agent(FakeEnvironment(machine="aarch64"))
        write_run_files(self.root / "logs" / "coding-agent")
        context = AgentContext()

        agent.populate_context_post_run(context)

        assert context.metadata is not None
        self.assertEqual(context.metadata["installed_executable"], "coding-agent-linux-arm64")


class ManifestFixtureTest(unittest.TestCase):
    def test_write_artifact_keeps_the_fixture_shape(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data = write_artifact(Path(temp))
        self.assertEqual(data.keys(), manifest_data().keys())
        parse_manifest(data)


if __name__ == "__main__":
    unittest.main()
