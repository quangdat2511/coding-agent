"""Reads the artifact-manifest.json that `bun run build:artifact` writes (ADR 0005 §2).

The shape is the `ArtifactManifest` interface in scripts/build-artifact.ts. A change there changes
this module in the same pull request.
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MANIFEST_FILE = "artifact-manifest.json"

SCHEMA_VERSION = 1

# `Bun.CryptoHasher("sha256").digest("hex")` in scripts/build-artifact.ts writes this form.
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")


class ArtifactManifestError(ValueError):
    """The artifact directory has no manifest, or the manifest does not have the expected shape."""


@dataclass(frozen=True)
class ArtifactExecutable:
    file: str
    target: str
    sha256: str


@dataclass(frozen=True)
class ArtifactManifest:
    version: str
    commit: str
    dirty: bool
    bun_version: str
    executables: tuple[ArtifactExecutable, ...]

    @property
    def agent_version(self) -> str:
        """The version that the adapter reports to Harbor: the Coding Agent version and commit."""
        return f"{self.version} {self.commit}"

    @property
    def version_line(self) -> str:
        """The line that `coding-agent --version` prints for this build, without its newline.

        It matches `formatVersion` in packages/coding-agent/src/build-info.ts.
        """
        return f"coding-agent {self.agent_version}"


def load_manifest(artifact_dir: Path) -> ArtifactManifest:
    """Reads and checks `artifact-manifest.json` in `artifact_dir`."""
    path = artifact_dir / MANIFEST_FILE
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise ArtifactManifestError(
            f"{path} does not exist; give the adapter the directory that "
            "`bun run build:artifact` wrote"
        ) from None
    except OSError as exc:
        raise ArtifactManifestError(f"cannot read {path}: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ArtifactManifestError(f"{path} is not valid JSON: {exc}") from exc
    return parse_manifest(data, source=str(path))


def parse_manifest(data: Any, *, source: str = MANIFEST_FILE) -> ArtifactManifest:
    """Checks the decoded manifest and returns it. Every problem names `source`."""

    def fail(message: str) -> ArtifactManifestError:
        return ArtifactManifestError(f"{source}: {message}")

    def text(value: Any, field: str) -> str:
        if not isinstance(value, str) or value.strip() == "":
            raise fail(f"{field} must be a non-empty string")
        return value

    if not isinstance(data, dict):
        raise fail("the manifest must be a JSON object")
    schema_version = data.get("schemaVersion")
    # `True == 1` in Python, so a boolean is refused before the comparison.
    if isinstance(schema_version, bool) or schema_version != SCHEMA_VERSION:
        raise fail(
            f"schemaVersion must be {SCHEMA_VERSION}, found {json.dumps(schema_version)}; "
            "this adapter reads only that schema"
        )
    coding_agent = data.get("codingAgent")
    if not isinstance(coding_agent, dict):
        raise fail("codingAgent must be an object")
    version = text(coding_agent.get("version"), "codingAgent.version")
    commit = text(coding_agent.get("commit"), "codingAgent.commit")
    dirty = data.get("dirty")
    if not isinstance(dirty, bool):
        raise fail("dirty must be a boolean")
    bun_version = text(data.get("bunVersion"), "bunVersion")
    raw_executables = data.get("executables")
    if not isinstance(raw_executables, list) or len(raw_executables) == 0:
        raise fail("executables must be a non-empty array")
    executables: list[ArtifactExecutable] = []
    for index, entry in enumerate(raw_executables):
        if not isinstance(entry, dict):
            raise fail(f"executables[{index}] must be an object")
        file = text(entry.get("file"), f"executables[{index}].file")
        # The adapter joins the name to the artifact directory, so a path could leave it.
        if "/" in file or "\\" in file or file in (".", ".."):
            raise fail(f"executables[{index}].file must be a file name, found {json.dumps(file)}")
        sha256 = text(entry.get("sha256"), f"executables[{index}].sha256")
        if SHA256_PATTERN.fullmatch(sha256) is None:
            raise fail(
                f"executables[{index}].sha256 must be 64 lowercase hex digits, "
                f"found {json.dumps(sha256)}"
            )
        executables.append(
            ArtifactExecutable(
                file=file,
                target=text(entry.get("target"), f"executables[{index}].target"),
                sha256=sha256,
            )
        )
    return ArtifactManifest(
        version=version,
        commit=commit,
        dirty=dirty,
        bun_version=bun_version,
        executables=tuple(executables),
    )
