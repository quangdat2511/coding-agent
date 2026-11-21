"""Installs the artifact in a task container for the credential isolation test (ADR 0005 §6).

This follows the steps of `CodingAgent.install()` in `agent.py` and uses the same checks from
`install.py`, so the test runs the build that a job would install, at the same path. It does not
call `install()` itself: the agent's constructor refuses a key that is not the host's, and this
test never reads the environment of the host. It imports nothing from Harbor.
"""

import asyncio
from pathlib import Path
from typing import Any, Protocol

from coding_agent_terminalbench.install import (
    INSTALLED_EXECUTABLE,
    ArtifactInstallError,
    check_executable,
    check_uploaded_sha256,
    check_version_output,
    select_executable,
)
from coding_agent_terminalbench.manifest import load_manifest


class Container(Protocol):
    async def exec(self, command: str, user: str | int | None = None, **kwargs: Any) -> Any: ...

    async def upload_file(self, source_path: Path | str, target_path: str) -> None: ...


async def install_artifact(container: Container, artifact_dir: Path) -> None:
    """Uploads the executable that fits the container and checks it. It raises
    ArtifactInstallError when the container cannot run this build."""
    manifest = load_manifest(artifact_dir)

    uname = await container.exec("uname -m")
    machine = (uname.stdout or "").strip()
    if uname.return_code != 0 or machine == "":
        raise ArtifactInstallError(
            f"cannot read the task container's architecture: `uname -m` exited {uname.return_code}"
        )
    executable = select_executable(manifest, machine)

    # Hashing about 94 MB takes a moment, so it runs in a thread.
    source = await asyncio.to_thread(check_executable, artifact_dir, executable)
    await container.exec("mkdir -p /installed-agent", user="root")
    await container.upload_file(source, INSTALLED_EXECUTABLE)
    digest = await container.exec(f"sha256sum {INSTALLED_EXECUTABLE}", user="root")
    if digest.return_code != 0:
        raise ArtifactInstallError(
            f"sha256sum {INSTALLED_EXECUTABLE} exited {digest.return_code}: the task container "
            "needs sha256sum for this test, because it records the digest that it ran"
        )
    check_uploaded_sha256(executable, digest.stdout)
    # upload_file copies as root. Mode 0755 lets the agent user run the file.
    await container.exec(f"chmod 0755 {INSTALLED_EXECUTABLE}", user="root")

    # The agent's bash tool needs bash, and this test installs nothing to provide it.
    bash = await container.exec("command -v bash >/dev/null 2>&1", user="root")
    if bash.return_code != 0:
        raise ArtifactInstallError("the task container has no bash, which the agent's bash tool needs")

    # It runs as the container's default user, so this also proves that this user can run it.
    printed = await container.exec(f"{INSTALLED_EXECUTABLE} --version")
    if printed.return_code != 0:
        raise ArtifactInstallError(
            f"{INSTALLED_EXECUTABLE} --version exited {printed.return_code} with stderr "
            f"{(printed.stderr or '').strip()!r}"
        )
    check_version_output(manifest, printed.stdout)
