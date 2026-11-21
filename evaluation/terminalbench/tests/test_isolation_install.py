"""The install step of the credential isolation test (ADR 0005 §6), on a scripted container."""

import asyncio
import hashlib
import tempfile
import unittest
from dataclasses import dataclass, field
from pathlib import Path

from coding_agent_terminalbench.install import INSTALLED_EXECUTABLE, ArtifactInstallError
from coding_agent_terminalbench.isolation_install import install_artifact
from tests.support import COMMIT, ExecOutcome, write_artifact

VERSION_LINE = f"coding-agent 0.0.1 {COMMIT}\n"


@dataclass
class Container:
    machine: str = "x86_64"
    has_bash: bool = True
    damage_upload: bool = False
    version_stdout: str = VERSION_LINE
    commands: list[tuple[str, str | int | None]] = field(default_factory=list)
    uploaded: dict[str, bytes] = field(default_factory=dict)

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        content = Path(source_path).read_bytes()
        self.uploaded[target_path] = content + b"x" if self.damage_upload else content

    async def exec(self, command: str, user: str | int | None = None, **_: object) -> ExecOutcome:
        self.commands.append((command, user))
        if command == "uname -m":
            return ExecOutcome(stdout=f"{self.machine}\n")
        if command.startswith("sha256sum"):
            digest = hashlib.sha256(self.uploaded[INSTALLED_EXECUTABLE]).hexdigest()
            return ExecOutcome(stdout=f"{digest}  {INSTALLED_EXECUTABLE}\n")
        if command.startswith("command -v bash"):
            return ExecOutcome(return_code=0 if self.has_bash else 1)
        if command == f"{INSTALLED_EXECUTABLE} --version":
            return ExecOutcome(stdout=self.version_stdout)
        return ExecOutcome()


def install(container: Container) -> None:
    with tempfile.TemporaryDirectory() as directory:
        artifact_dir = Path(directory) / "artifact"
        write_artifact(artifact_dir)
        asyncio.run(install_artifact(container, artifact_dir))


class InstallArtifactTest(unittest.TestCase):
    def test_it_uploads_the_executable_that_fits_the_container_and_makes_it_runnable(self) -> None:
        container = Container(machine="x86_64")

        install(container)

        self.assertEqual(
            container.uploaded[INSTALLED_EXECUTABLE], b"fake bun-linux-x64-baseline executable\n"
        )
        self.assertIn((f"chmod 0755 {INSTALLED_EXECUTABLE}", "root"), container.commands)

    def test_the_version_check_runs_as_the_default_user_not_as_root(self) -> None:
        container = Container()

        install(container)

        self.assertIn((f"{INSTALLED_EXECUTABLE} --version", None), container.commands)

    def test_bytes_that_changed_on_the_way_are_refused(self) -> None:
        with self.assertRaisesRegex(ArtifactInstallError, "SHA-256"):
            install(Container(damage_upload=True))

    def test_a_container_without_bash_is_refused_and_nothing_is_installed_to_fix_it(self) -> None:
        container = Container(has_bash=False)

        with self.assertRaisesRegex(ArtifactInstallError, "no bash"):
            install(container)

        self.assertFalse([c for c, _ in container.commands if "apt" in c or "apk" in c])

    def test_a_build_that_is_not_the_one_in_the_manifest_is_refused(self) -> None:
        with self.assertRaisesRegex(ArtifactInstallError, "--version printed"):
            install(Container(version_stdout="coding-agent 9.9.9 deadbeef\n"))


if __name__ == "__main__":
    unittest.main()
