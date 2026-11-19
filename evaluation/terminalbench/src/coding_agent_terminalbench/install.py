"""The host-side checks of the install step (ADR 0005 §6): which executable, and is it that build.

This module imports nothing from Harbor. `CodingAgent.install()` in agent.py runs the steps in the
task container and calls these functions for the parts that need no container.
"""

import hashlib
from pathlib import Path

from coding_agent_terminalbench.manifest import ArtifactExecutable, ArtifactManifest

# The path in the task container where install() puts the executable. run() starts it.
INSTALLED_EXECUTABLE = "/installed-agent/coding-agent"

# `uname -m` in a Linux container, mapped to the Bun target that scripts/build-artifact.ts builds
# for that architecture (ADR 0005 §2). Any other value fails setup.
MACHINE_TARGETS: dict[str, str] = {
    "x86_64": "bun-linux-x64-baseline",
    "aarch64": "bun-linux-arm64",
}

# A shell exits 127 when it cannot start a file. For a file that exists, the usual cause is a
# missing ELF interpreter: the executables link against glibc (ADR 0005 §2).
GLIBC_HINT = (
    "; the executable needs glibc 2.17 or newer, so an image with musl libc (for example Alpine) "
    "cannot start it"
)


# Harbor's Docker and Modal environments run every command through `bash -c`, so in an image
# without bash the first command of install() exits 126 or 127 before it reaches the container.
BASH_HINT = "; Harbor runs every command through bash, so the image may have no bash"


class ArtifactInstallError(RuntimeError):
    """The artifact cannot be installed as the build that the manifest names.

    It subclasses RuntimeError, so Harbor's `setup()` raises it unchanged and the trial result
    records this class name. The trial then has no verifier reward, so the rerun job of ADR 0005 §7
    runs it once more.
    """


def select_executable(manifest: ArtifactManifest, machine: str) -> ArtifactExecutable:
    """The manifest's executable for the architecture that `uname -m` printed."""
    target = MACHINE_TARGETS.get(machine)
    if target is None:
        supported = ", ".join(sorted(MACHINE_TARGETS))
        raise ArtifactInstallError(
            f"the task container's architecture is {machine!r}; the artifact supports only "
            f"{supported}"
        )
    matches = [executable for executable in manifest.executables if executable.target == target]
    if len(matches) != 1:
        raise ArtifactInstallError(
            f"artifact-manifest.json must list exactly one executable for {target} "
            f"(architecture {machine}), found {len(matches)}"
        )
    return matches[0]


def check_executable(artifact_dir: Path, executable: ArtifactExecutable) -> Path:
    """The host path of the executable, after its SHA-256 matches the manifest."""
    path = artifact_dir / executable.file
    try:
        with path.open("rb") as file:
            # hexdigest() is lowercase hex, the form of the manifest.
            actual = hashlib.file_digest(file, "sha256").hexdigest()
    except FileNotFoundError:
        raise ArtifactInstallError(
            f"{path} does not exist; artifact-manifest.json lists it for {executable.target}"
        ) from None
    except OSError as exc:
        raise ArtifactInstallError(f"cannot read {path}: {exc}") from exc
    if actual != executable.sha256:
        raise ArtifactInstallError(
            f"the SHA-256 of {path} is {actual}, but artifact-manifest.json records "
            f"{executable.sha256}; rebuild the artifact or give the directory that built it"
        )
    return path


def check_uploaded_sha256(executable: ArtifactExecutable, stdout: str | None) -> None:
    """Fails unless `sha256sum` in the container printed the manifest's SHA-256.

    The host check runs before the upload, so this one catches bytes that changed on the host
    after it, or that the upload damaged. `--version` does not: a Bun executable with its end cut
    off can still print the right version line.
    """
    printed = (stdout or "").split()
    actual = printed[0] if printed else ""
    if actual != executable.sha256:
        raise ArtifactInstallError(
            f"the SHA-256 of {INSTALLED_EXECUTABLE} in the task container is {actual!r}, but "
            f"artifact-manifest.json records {executable.sha256} for {executable.file}; the upload "
            "changed the file, or the file on the host changed after the check"
        )


def check_version_output(manifest: ArtifactManifest, stdout: str | None) -> None:
    """Fails unless `coding-agent --version` printed the line that the manifest predicts."""
    printed = (stdout or "").strip()
    if printed != manifest.version_line:
        raise ArtifactInstallError(
            f"{INSTALLED_EXECUTABLE} --version printed {printed!r}, but artifact-manifest.json "
            f"names {manifest.version_line!r}"
        )
