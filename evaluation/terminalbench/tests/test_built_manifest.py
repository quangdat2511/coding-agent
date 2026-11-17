"""Reads the manifest that `bun run build:artifact` wrote, in the directory that CI gives.

The other tests read the fixture in tests/support.py, which is written by hand. These tests fail
when the built manifest and the fixture differ, for example when scripts/build-artifact.ts renames
a field. CI sets the variable in the `TerminalBench adapter` job, after the `Evaluation artifact`
job uploads the manifest.
"""

import json
import os
import unittest
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.manifest import MANIFEST_FILE, load_manifest
from tests.support import manifest_data

ARTIFACT_DIR_VARIABLE = "CODING_AGENT_ARTIFACT_DIR"


def shape(value: Any) -> Any:
    """The keys and value types of a decoded manifest, with only the first item of each array."""
    if isinstance(value, dict):
        return {key: shape(item) for key, item in value.items()}
    if isinstance(value, list):
        return [shape(item) for item in value[:1]]
    return type(value).__name__


@unittest.skipUnless(
    os.environ.get(ARTIFACT_DIR_VARIABLE),
    f"{ARTIFACT_DIR_VARIABLE} is not set; CI sets it to the directory of the built manifest",
)
class BuiltManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.artifact_dir = Path(os.environ[ARTIFACT_DIR_VARIABLE])

    def test_the_adapter_reads_the_built_manifest(self) -> None:
        load_manifest(self.artifact_dir)

    def test_the_fixture_has_the_shape_of_the_built_manifest(self) -> None:
        built = json.loads((self.artifact_dir / MANIFEST_FILE).read_text(encoding="utf-8"))
        self.assertEqual(shape(manifest_data()), shape(built))


if __name__ == "__main__":
    unittest.main()
