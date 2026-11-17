import tempfile
import unittest
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.manifest import (
    ArtifactExecutable,
    ArtifactManifestError,
    load_manifest,
    parse_manifest,
)
from tests.support import COMMIT, manifest_data, write_manifest


class LoadManifestTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.artifact_dir = Path(temp.name)

    def test_reads_the_manifest_that_the_build_writes(self) -> None:
        write_manifest(self.artifact_dir, manifest_data())
        manifest = load_manifest(self.artifact_dir)
        self.assertEqual(manifest.version, "0.0.1")
        self.assertEqual(manifest.commit, COMMIT)
        self.assertFalse(manifest.dirty)
        self.assertEqual(manifest.bun_version, "1.3.14")
        self.assertEqual(
            manifest.executables,
            (
                ArtifactExecutable("coding-agent-linux-x64", "bun-linux-x64-baseline", "a" * 64),
                ArtifactExecutable("coding-agent-linux-arm64", "bun-linux-arm64", "b" * 64),
            ),
        )

    def test_a_missing_manifest_names_the_build_command(self) -> None:
        with self.assertRaisesRegex(ArtifactManifestError, "bun run build:artifact"):
            load_manifest(self.artifact_dir)

    def test_invalid_json_is_refused(self) -> None:
        (self.artifact_dir / "artifact-manifest.json").write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(ArtifactManifestError, "not valid JSON"):
            load_manifest(self.artifact_dir)


class ParseManifestTest(unittest.TestCase):
    def assert_refused(self, data: Any, message: str) -> None:
        with self.assertRaisesRegex(ArtifactManifestError, message):
            parse_manifest(data)

    def test_a_non_object_is_refused(self) -> None:
        self.assert_refused([], "must be a JSON object")

    def test_another_schema_version_is_refused(self) -> None:
        self.assert_refused(manifest_data(schemaVersion=2), "schemaVersion must be 1, found 2")
        self.assert_refused(manifest_data(schemaVersion=True), "found true")
        self.assert_refused(manifest_data(schemaVersion="1"), 'found "1"')

    def test_coding_agent_fields_are_required(self) -> None:
        self.assert_refused(manifest_data(codingAgent=None), "codingAgent must be an object")
        self.assert_refused(
            manifest_data(codingAgent={"version": "", "commit": COMMIT}),
            "codingAgent.version must be a non-empty string",
        )
        self.assert_refused(
            manifest_data(codingAgent={"version": "0.0.1"}),
            "codingAgent.commit must be a non-empty string",
        )

    def test_dirty_must_be_a_boolean(self) -> None:
        self.assert_refused(manifest_data(dirty="false"), "dirty must be a boolean")

    def test_bun_version_is_required(self) -> None:
        self.assert_refused(manifest_data(bunVersion=None), "bunVersion must be a non-empty string")

    def test_executables_must_be_listed(self) -> None:
        self.assert_refused(manifest_data(executables=[]), "executables must be a non-empty array")
        self.assert_refused(manifest_data(executables=["x"]), r"executables\[0\] must be an object")
        self.assert_refused(
            manifest_data(executables=[{"file": "f", "target": "t"}]),
            r"executables\[0\]\.sha256 must be a non-empty string",
        )

    def test_an_executable_must_be_a_file_name_in_the_artifact_dir(self) -> None:
        for file in ["../coding-agent", "/usr/bin/bash", "bin\\coding-agent", ".", ".."]:
            with self.subTest(file=file):
                self.assert_refused(
                    manifest_data(executables=[{"file": file, "target": "t", "sha256": "a" * 64}]),
                    r"executables\[0\]\.file must be a file name",
                )

    def test_a_sha256_must_be_64_lowercase_hex_digits(self) -> None:
        for sha256 in ["abc", "A" * 64, "g" * 64, "a" * 65]:
            with self.subTest(sha256=sha256):
                self.assert_refused(
                    manifest_data(executables=[{"file": "f", "target": "t", "sha256": sha256}]),
                    r"executables\[0\]\.sha256 must be 64 lowercase hex digits",
                )


if __name__ == "__main__":
    unittest.main()
