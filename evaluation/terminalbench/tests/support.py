import json
from pathlib import Path
from typing import Any

COMMIT = "64128afd1c0f27db530cf167b015d206ef67c707"


def manifest_data(**overrides: Any) -> dict[str, Any]:
    """A manifest with the shape that scripts/build-artifact.ts writes.

    The fixture is written by hand. test_built_manifest.py compares its shape with the manifest
    that the build wrote in CI, so a change to the build's schema fails there.
    """
    data: dict[str, Any] = {
        "schemaVersion": 1,
        "codingAgent": {"version": "0.0.1", "commit": COMMIT},
        "dirty": False,
        "bunVersion": "1.3.14",
        "executables": [
            {
                "file": "coding-agent-linux-x64",
                "target": "bun-linux-x64-baseline",
                "sha256": "a" * 64,
            },
            {
                "file": "coding-agent-linux-arm64",
                "target": "bun-linux-arm64",
                "sha256": "b" * 64,
            },
        ],
    }
    data.update(overrides)
    return data


def write_manifest(artifact_dir: Path, data: Any) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / "artifact-manifest.json").write_text(
        f"{json.dumps(data, indent=2)}\n", encoding="utf-8"
    )
