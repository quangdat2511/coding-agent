"""The committed dataset record of ADR 0008 §1 and §4.

The default pin's record is ADR 0008 §4 itself, so one test reads that file. The other tests write a
small record in the same two-column table shape, which ADR 0008 §1 requires of another dataset's
committed file.
"""

import tempfile
import unittest
from pathlib import Path

from coding_agent_terminalbench.dataset_record import (
    DatasetRecordError,
    MINIMUM_SMOKE_TASKS,
    parse_dataset_record,
    parse_seconds,
    read_dataset_record,
)
from tests.support import dataset_record_markdown

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
ADR_0008 = REPOSITORY_ROOT / "docs/adr/0008-evaluation-dataset-as-a-job-parameter.md"

IDENTIFIER = "example-org/example-tasks@1.2.0"
COMMIT = "c" * 40


def record_markdown(**overrides: str | None) -> str:
    """A dataset record in the shape of ADR 0008 §4, with the named rows overridden."""
    rows: dict[str, str] = {
        "Dataset identifier": f"\x60{IDENTIFIER}\x60",
        "Source repository": "\x60https://example.com/example-org/example-tasks\x60",
        "Release tag": "\x60v1.2.0\x60",
        "Release commit": f"\x60{COMMIT}\x60",
        "Task count": "the release's task list",
        "Environment": "a Dockerfile per task",
        "Single step": "every task",
        "Verifier environment": "separate, every task",
        "Per-task agent timeout": "28,800 s",
        "Smoke tasks": (
            "\x60example-org/alpha\x60, \x60example-org/bravo\x60, "
            "\x60example-org/charlie\x60"
        ),
        "Tasks with declared MCP servers": "\x60example-org/alpha\x60",
        "Tasks with a declared skills directory": "\x60example-org/bravo\x60",
    }
    for label, value in overrides.items():
        if value is None:
            rows.pop(label, None)
        else:
            rows[label] = value
    return dataset_record_markdown(rows)


def parse(**overrides: str | None):
    return parse_dataset_record(record_markdown(**overrides), source="record.md")


class ReadRecordTest(unittest.TestCase):
    def test_reads_the_identity_and_the_evidence(self) -> None:
        record = parse()
        self.assertEqual(record.identifier, IDENTIFIER)
        self.assertEqual(record.package_name, "example-org/example-tasks")
        self.assertEqual(record.source_repository, "https://example.com/example-org/example-tasks")
        self.assertEqual(record.release_tag, "v1.2.0")
        self.assertEqual(record.release_commit, COMMIT)
        self.assertEqual(
            record.smoke_tasks,
            ("example-org/alpha", "example-org/bravo", "example-org/charlie"),
        )
        self.assertEqual(record.mcp_server_tasks, ("example-org/alpha",))
        self.assertEqual(record.skills_tasks, ("example-org/bravo",))
        self.assertEqual(record.admissibility_problems, ())
        self.assertEqual(
            [property_evidence.name for property_evidence in record.properties],
            [
                "image-based-tasks",
                "single-step-tasks",
                "separate-verifier-environment",
                "per-task-agent-timeout",
            ],
        )
        for property_evidence in record.properties:
            self.assertTrue(property_evidence.shown)
            self.assertRegex(property_evidence.source or "", r"^record\.md:\d+$")

    def test_the_default_pin_is_read_from_adr_0008(self) -> None:
        # ADR 0008 §5 forbids a test to hardcode a dataset name, version or task count, so this
        # test reads the committed record and checks its shape rather than the default pin's data.
        record = read_dataset_record(ADR_0008)
        name, _, version = record.identifier.rpartition("@")
        self.assertIn("/", name)
        self.assertNotEqual(version, "")
        self.assertNotIn("latest", record.identifier)
        self.assertRegex(record.source_repository, r"^https://")
        self.assertNotEqual(record.release_tag, "")
        self.assertRegex(record.release_commit, r"^[0-9a-f]{40}$")
        self.assertGreaterEqual(len(record.smoke_tasks), MINIMUM_SMOKE_TASKS)
        self.assertEqual(record.admissibility_problems, ())
        timeout = parse_seconds(record.property("per-task-agent-timeout").evidence or "")
        self.assertIsNotNone(timeout)
        self.assertGreater(timeout or 0, 0)

    def test_a_row_label_may_carry_markdown(self) -> None:
        text = record_markdown().replace("| Dataset identifier |", "| **Dataset identifier** |")
        record = parse_dataset_record(text, source="record.md")
        self.assertEqual(record.identifier, IDENTIFIER)

    def test_a_row_written_as_none_names_no_task(self) -> None:
        record = parse(**{"Tasks with declared MCP servers": "none"})
        self.assertEqual(record.mcp_server_tasks, ())

    def test_a_missing_optional_row_is_empty(self) -> None:
        record = parse(**{"Tasks with declared MCP servers": None})
        self.assertEqual(record.mcp_server_tasks, ())

    def test_row_source_names_the_line_of_the_row(self) -> None:
        record = parse()
        line = record.row_source("dataset identifier")
        self.assertRegex(line or "", r"^record\.md:\d+$")
        self.assertEqual(int((line or "").rsplit(":", 1)[1]), 5)


class RecordErrorTest(unittest.TestCase):
    def test_a_missing_identity_row_is_refused(self) -> None:
        with self.assertRaisesRegex(DatasetRecordError, "dataset identifier"):
            parse(**{"Dataset identifier": None})

    def test_a_duplicate_row_is_refused(self) -> None:
        text = record_markdown() + "| Release tag | \x60v2.0.0\x60 |\n"
        with self.assertRaisesRegex(DatasetRecordError, "appears at line"):
            parse_dataset_record(text, source="record.md")

    def test_an_identifier_without_a_version_is_refused(self) -> None:
        with self.assertRaisesRegex(DatasetRecordError, "org/name@version"):
            parse(**{"Dataset identifier": "\x60example-org/example-tasks\x60"})

    def test_a_release_commit_that_is_not_a_commit_is_refused(self) -> None:
        with self.assertRaisesRegex(DatasetRecordError, "40 lowercase hex digits"):
            parse(**{"Release commit": "\x60v1.2.0\x60"})

    def test_a_task_row_without_task_names_is_refused(self) -> None:
        with self.assertRaisesRegex(DatasetRecordError, "code spans"):
            parse(**{"Tasks with declared MCP servers": "some tasks"})

    def test_a_missing_file_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(DatasetRecordError, "does not exist"):
                read_dataset_record(Path(directory) / "missing.md")

    def test_a_file_that_is_not_utf8_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "record.md"
            path.write_bytes(b"\xff\xfe")
            with self.assertRaisesRegex(DatasetRecordError, "cannot read"):
                read_dataset_record(path)

    def test_an_unreadable_identity_row_row_is_left_to_the_manifest(self) -> None:
        # The commit row is the record's identity, so a missing evidence row cannot hide it.
        record = parse(**{"Environment": None, "Single step": None})
        self.assertFalse(record.property("image-based-tasks").shown)
        self.assertEqual(len(record.admissibility_problems), 2)


class AdmissibilityTest(unittest.TestCase):
    def test_a_missing_evidence_row_makes_the_dataset_inadmissible(self) -> None:
        record = parse(**{"Verifier environment": None})
        problems = record.admissibility_problems
        self.assertEqual(len(problems), 1)
        self.assertIn("separate-verifier-environment", problems[0])

    def test_fewer_smoke_tasks_than_adr_0008_requires_is_inadmissible(self) -> None:
        self.assertGreaterEqual(MINIMUM_SMOKE_TASKS, 3)
        record = parse(**{"Smoke tasks": "\x60example-org/alpha\x60, \x60example-org/bravo\x60"})
        problems = record.admissibility_problems
        self.assertEqual(len(problems), 1)
        self.assertIn(str(MINIMUM_SMOKE_TASKS), problems[0])

    def test_an_unrelated_table_is_ignored(self) -> None:
        text = (
            record_markdown()
            + "\\n| Statement | Source |"
            + "\\n| --- | --- |"
            + "\\n| read in source | task.toml |\\n"
        )
        record = parse_dataset_record(text, source="record.md")
        self.assertEqual(record.identifier, IDENTIFIER)


class SecondsTest(unittest.TestCase):
    def test_reads_the_seconds_of_a_timeout_row(self) -> None:
        self.assertEqual(parse_seconds("28,800 s"), 28_800)
        self.assertEqual(parse_seconds("3600 seconds"), 3_600)
        self.assertIsNone(parse_seconds("the task's own timeout"))
        self.assertIsNone(parse_seconds(""))


if __name__ == "__main__":
    unittest.main()
