"""Scans an uncompressed job directory for credentials (ADR 0005 §8)."""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any
from unittest import mock

from coding_agent_terminalbench import secret_scan
from coding_agent_terminalbench.secret_scan import (
    KEY_PREFIXES,
    REDACTED_MARKER,
    SecretMatch,
    SecretScanError,
    read_credentials,
    read_review,
    report_text,
    scan_record,
    scan_roots,
)


class SecretScanTestCase(unittest.TestCase):
    """A job directory that a test fills with the files it names."""

    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.temp = Path(temp.name)
        self.root = self.temp / "jobs" / "job-1"
        self.root.mkdir(parents=True)

    def write(self, relative: str, data: bytes | str) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)
        return path

    def display(self, relative: str) -> str:
        return (self.root / relative).as_posix()

    def write_review(self, entries: list[dict[str, Any]]) -> Path:
        path = self.temp / "review.json"
        path.write_text(json.dumps({"reviewed": entries}), encoding="utf-8")
        return path

    def run_main(
        self, *argv: str, environment: dict[str, str] | None = None
    ) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = secret_scan.main(list(argv), environment=environment)
        return code, stdout.getvalue(), stderr.getvalue()


class MatchTest(SecretScanTestCase):
    def test_each_key_prefix_is_reported(self) -> None:
        for index, prefix in enumerate(KEY_PREFIXES):
            with self.subTest(prefix=prefix):
                directory = self.temp / f"prefix-{index}"
                directory.mkdir()
                log = directory / "log.txt"
                log.write_text(f"key={prefix}abc", encoding="utf-8")

                report = scan_roots([directory], {})

                self.assertEqual(
                    report.matches,
                    (SecretMatch(log.as_posix(), 4, "key-prefix", prefix),),
                )
                self.assertFalse(report.passed)

    def test_the_redacted_marker_is_reported(self) -> None:
        self.write("log.txt", "before [REDACTED] after")

        report = scan_roots([self.root], {})

        self.assertEqual(report.files_scanned, 1)
        self.assertEqual(
            report.matches,
            (SecretMatch(self.display("log.txt"), 7, "redacted", REDACTED_MARKER),),
        )
        self.assertFalse(report.passed)
        self.assertEqual(report.unexplained, report.matches)

    def test_a_credential_value_is_reported(self) -> None:
        value = "s3cr3t-v4lue"
        self.write("run.log", f"token: {value}\n")

        report = scan_roots([self.root], {"OPENAI_API_KEY": value})

        self.assertEqual(
            report.matches,
            (SecretMatch(self.display("run.log"), 7, "credential", "OPENAI_API_KEY"),),
        )
        self.assertEqual(report.credential_variables, ("OPENAI_API_KEY",))
        self.assertFalse(report.passed)

    def test_a_credential_that_starts_with_a_key_prefix_is_reported_as_one(self) -> None:
        value = "sk-ant-api03-verysecret"
        self.write("run.log", f"x {value}")

        report = scan_roots([self.root], {"ANTHROPIC_API_KEY": value})

        self.assertEqual(
            [(match.kind, match.offset, match.detail) for match in report.matches],
            [("credential", 2, "ANTHROPIC_API_KEY"), ("key-prefix", 2, "sk-ant-")],
        )
        self.assertEqual(len(report.unexplained), 2)
        self.assertIn("2 unexplained matches", report_text(report))

    def test_a_binary_file_is_scanned(self) -> None:
        value = "s3cr3t-v4lue"
        header = b"\x89PNG\r\n\x1a\n\x00\xff"
        self.write("diagram.png", header + value.encode("utf-8") + b"\x00\x01")

        report = scan_roots([self.root], {"OPENAI_API_KEY": value})

        self.assertEqual(
            report.matches,
            (
                SecretMatch(
                    self.display("diagram.png"), len(header), "credential", "OPENAI_API_KEY"
                ),
            ),
        )

    def test_the_offset_counts_utf_8_bytes_not_characters(self) -> None:
        prefix = "Tiếng Việt: "
        self.write("log.txt", prefix + "[REDACTED]")

        report = scan_roots([self.root], {})

        self.assertEqual(report.matches[0].offset, len(prefix.encode("utf-8")))
        self.assertEqual(report.matches[0].kind, "redacted")

    def test_the_redacted_marker_is_found_in_utf_16(self) -> None:
        # A UTF-16-BE file also holds the little endian bytes one byte later, so the scan keeps
        # that match (offset 1) and drops the big endian duplicate, as the docstring explains.
        for encoding, offset in (("utf-16-le", 0), ("utf-16-be", 0)):
            with self.subTest(encoding=encoding):
                directory = self.temp / f"redacted-{encoding}"
                directory.mkdir()
                log = directory / "log.bin"
                log.write_bytes(REDACTED_MARKER.encode(encoding))

                report = scan_roots([directory], {})

                self.assertEqual(
                    report.matches,
                    (SecretMatch(log.as_posix(), offset, "redacted", REDACTED_MARKER),),
                )

    def test_a_key_prefix_is_found_in_utf_16(self) -> None:
        for encoding, offset in (("utf-16-le", 0), ("utf-16-be", 0)):
            with self.subTest(encoding=encoding):
                directory = self.temp / f"prefix-{encoding}"
                directory.mkdir()
                log = directory / "log.bin"
                log.write_bytes("oc_sk_".encode(encoding))

                report = scan_roots([directory], {})

                self.assertEqual(
                    report.matches,
                    (SecretMatch(log.as_posix(), offset, "key-prefix", "oc_sk_"),),
                )

    def test_a_credential_is_found_in_utf_16(self) -> None:
        value = "s3cr3t-v4lue"
        for encoding, offset in (("utf-16-le", 0), ("utf-16-be", 0)):
            with self.subTest(encoding=encoding):
                directory = self.temp / f"utf16-{encoding}"
                directory.mkdir()
                log = directory / "log.bin"
                log.write_bytes(value.encode(encoding))

                report = scan_roots([directory], {"OPENAI_API_KEY": value})

                self.assertEqual(
                    report.matches,
                    (SecretMatch(log.as_posix(), offset, "credential", "OPENAI_API_KEY"),),
                )

    def test_a_shifted_view_of_utf_16_text_is_reported_once(self) -> None:
        # Around a UTF-16 text, the high byte of an ASCII character and the bytes of the next
        # UTF-16 unit form a view of the same text one byte away from its own encoding. The scan
        # reports that one occurrence once, not the duplicate view of it.
        for encoding, offset in (("utf-16-le", 2), ("utf-16-be", 3)):
            with self.subTest(encoding=encoding):
                directory = self.temp / f"shifted-{encoding}"
                directory.mkdir()
                log = directory / "log.bin"
                log.write_bytes(("x" + REDACTED_MARKER + "y").encode(encoding))

                report = scan_roots([directory], {})

                self.assertEqual(
                    report.matches,
                    (SecretMatch(log.as_posix(), offset, "redacted", REDACTED_MARKER),),
                )

    def test_matches_that_span_a_chunk_boundary_are_reported_once(self) -> None:
        value = "s3cr3t-v4lue"
        cases = [
            ("marker", "12345[REDACTED]tail", "redacted", REDACTED_MARKER, 5, {}),
            (
                "credential",
                f"xx{value}yy",
                "credential",
                "OPENAI_API_KEY",
                2,
                {"OPENAI_API_KEY": value},
            ),
        ]
        for name, data, kind, detail, offset, credentials in cases:
            with self.subTest(case=name):
                directory = self.temp / f"chunk-{name}"
                directory.mkdir()
                log = directory / "log.txt"
                log.write_bytes(data.encode("utf-8"))

                with mock.patch.object(secret_scan, "CHUNK_SIZE", 8):
                    report = scan_roots([directory], credentials)

                self.assertEqual(
                    report.matches, (SecretMatch(log.as_posix(), offset, kind, detail),)
                )

    def test_every_regular_file_is_counted_including_binaries(self) -> None:
        self.write("a.log", "nothing here")
        self.write("b.bin", b"\x00\x01\x02")
        self.write("nested/c.txt", "")
        self.write("empty.dat", b"")
        (self.root / "empty-dir").mkdir()

        report = scan_roots([self.root], {})

        self.assertEqual(report.files_scanned, 4)
        self.assertEqual(report.matches, ())
        self.assertTrue(report.passed)

    def test_matches_are_sorted_by_path_then_offset(self) -> None:
        self.write("b.log", "xx[REDACTED]")
        self.write("a.log", "[REDACTED] and [REDACTED]")

        report = scan_roots([self.root], {})

        self.assertEqual(
            [(match.path, match.offset) for match in report.matches],
            [
                (self.display("a.log"), 0),
                (self.display("a.log"), 15),
                (self.display("b.log"), 2),
            ],
        )

    @unittest.skipIf(sys.platform == "win32", "creating symlinks needs extra permission on Windows")
    def test_a_symlinked_file_is_followed_and_scanned(self) -> None:
        target = self.temp / "outside.log"
        target.write_text("x [REDACTED]", encoding="utf-8")
        (self.root / "link.log").symlink_to(target)

        report = scan_roots([self.root], {})

        self.assertEqual(report.files_scanned, 1)
        self.assertEqual(
            report.matches,
            (SecretMatch(self.display("link.log"), 2, "redacted", REDACTED_MARKER),),
        )

    @unittest.skipIf(sys.platform == "win32", "creating symlinks needs extra permission on Windows")
    def test_a_symbolic_link_without_a_target_is_an_error(self) -> None:
        (self.root / "dangling.log").symlink_to(self.temp / "missing.log")

        with self.assertRaisesRegex(SecretScanError, "symbolic link"):
            scan_roots([self.root], {})

    @unittest.skipIf(sys.platform == "win32", "creating symlinks needs extra permission on Windows")
    def test_a_symbolic_link_to_a_directory_is_an_error(self) -> None:
        (self.root / "real").mkdir()
        self.write("real/log.txt", "[REDACTED]")
        (self.root / "linked").symlink_to(self.root / "real", target_is_directory=True)

        with self.assertRaises(SecretScanError) as raised:
            scan_roots([self.root], {})

        message = str(raised.exception)
        self.assertIn("symbolic link to a directory", message)
        self.assertIn(self.display("linked"), message)

    def test_an_unreadable_file_is_an_error(self) -> None:
        self.write("blocked.log", "nothing")
        original_open = Path.open

        def refuse(path_self: Path, *args: Any, **kwargs: Any) -> Any:
            if path_self.name == "blocked.log":
                raise PermissionError(13, "Permission denied", str(path_self))
            return original_open(path_self, *args, **kwargs)

        with mock.patch.object(Path, "open", refuse):
            with self.assertRaisesRegex(SecretScanError, r"cannot read .*blocked\.log"):
                scan_roots([self.root], {})

    def test_a_root_that_does_not_exist_is_an_error(self) -> None:
        with self.assertRaisesRegex(SecretScanError, "does not exist"):
            scan_roots([self.root / "missing"], {})

    def test_a_file_root_is_scanned_and_named_as_given(self) -> None:
        path = self.write("log.txt", "[REDACTED]")

        report = scan_roots([str(path)], {})

        self.assertEqual(report.roots, (path.as_posix(),))
        self.assertEqual(report.files_scanned, 1)
        self.assertEqual(
            report.matches, (SecretMatch(path.as_posix(), 0, "redacted", REDACTED_MARKER),)
        )


class ReviewTest(SecretScanTestCase):
    def test_a_review_explains_redacted_and_prefix_matches(self) -> None:
        self.write("a.log", "xx[REDACTED]")
        self.write("b.log", "key=sk-or-example")
        reason_a = "Harbor's scrubber wrote this"
        reason_b = "a documentation example"
        review = {
            (self.display("a.log"), 2): reason_a,
            (self.display("b.log"), 4): reason_b,
        }

        report = scan_roots([self.root], {}, review)

        self.assertTrue(report.passed)
        self.assertEqual(report.unexplained, ())
        self.assertEqual(report.explanation_problems, ())
        self.assertEqual(
            [(match.kind, match.explanation) for match in report.matches],
            [("redacted", reason_a), ("key-prefix", reason_b)],
        )
        self.assertEqual(scan_record(report)["result"], "passed")
        text = report_text(report)
        self.assertIn("Scanned 2 files under 1 root: passed", text)
        self.assertNotIn("Explanation problems:", text)

    def test_an_unexplained_match_fails_the_scan(self) -> None:
        self.write("log.txt", "[REDACTED]")

        report = scan_roots([self.root], {})

        self.assertFalse(report.passed)
        self.assertEqual(len(report.unexplained), 1)
        self.assertEqual(report.explanation_problems, ())
        display = self.display("log.txt")
        text = report_text(report)
        self.assertIn(f"{display}:0: redacted [REDACTED] (unexplained)", text)
        self.assertIn("Scanned 1 file under 1 root: failed", text)
        self.assertIn("1 unexplained match", text)
        self.assertEqual(scan_record(report)["unexplained"], 1)

    def test_a_credential_match_cannot_be_explained(self) -> None:
        value = "s3cr3t-v4lue"
        self.write("log.txt", f"token {value}")
        review = {(self.display("log.txt"), 6): "It is not a credential"}

        report = scan_roots([self.root], {"OPENAI_API_KEY": value}, review)

        self.assertFalse(report.passed)
        self.assertEqual(len(report.explanation_problems), 1)
        problem = report.explanation_problems[0]
        self.assertIn("credential", problem)
        self.assertIn("OPENAI_API_KEY", problem)
        self.assertNotIn(value, problem)
        self.assertIsNone(report.matches[0].explanation)
        self.assertEqual(len(report.unexplained), 1)
        self.assertIn("Explanation problems:", report_text(report))

    def test_a_stale_review_entry_is_a_problem(self) -> None:
        self.write("log.txt", "nothing")
        review = {("elsewhere.log", 3): "not here any more"}

        report = scan_roots([self.root], {}, review)

        self.assertFalse(report.passed)
        self.assertEqual(report.matches, ())
        self.assertEqual(len(report.explanation_problems), 1)
        self.assertIn("no match", report.explanation_problems[0])
        self.assertIn("elsewhere.log at offset 3", report.explanation_problems[0])

    def test_read_review_reads_entries(self) -> None:
        path = self.write_review(
            [
                {"file": self.display("a.log"), "offset": 12, "reason": "Harbor's scrubber"},
                {"file": self.display("b.log"), "offset": 0, "reason": "an example"},
            ]
        )

        review = read_review(path)

        self.assertEqual(
            review,
            {
                (self.display("a.log"), 12): "Harbor's scrubber",
                (self.display("b.log"), 0): "an example",
            },
        )

    def test_read_review_rejects_a_missing_or_invalid_file(self) -> None:
        with self.subTest(case="missing"):
            with self.assertRaisesRegex(SecretScanError, "does not exist"):
                read_review(self.temp / "missing.json")
        with self.subTest(case="invalid JSON"):
            broken = self.temp / "broken.json"
            broken.write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(SecretScanError, "not valid JSON"):
                read_review(broken)

    def test_read_review_rejects_duplicate_entries(self) -> None:
        path = self.write_review(
            [
                {"file": "a.log", "offset": 1, "reason": "first"},
                {"file": "a.log", "offset": 1, "reason": "second"},
            ]
        )

        with self.assertRaisesRegex(SecretScanError, "repeats the entry"):
            read_review(path)

    def test_read_review_rejects_a_blank_reason(self) -> None:
        path = self.write_review([{"file": "a.log", "offset": 0, "reason": "   "}])

        with self.assertRaisesRegex(SecretScanError, "reason must be a non-empty string"):
            read_review(path)

    def test_read_review_rejects_malformed_entries(self) -> None:
        cases: list[tuple[Any, str]] = [
            ({"reviewed": {"file": "a.log"}}, '"reviewed" must be an array'),
            ({"reviewed": [1]}, "must be an object"),
            ({"reviewed": [{"file": "", "offset": 0, "reason": "x"}]}, "file must be a non-empty"),
            (
                {"reviewed": [{"file": "a.log", "offset": -1, "reason": "x"}]},
                "offset must be a non-negative integer",
            ),
            (
                {"reviewed": [{"file": "a.log", "offset": True, "reason": "x"}]},
                "offset must be a non-negative integer",
            ),
            ({"reviewed": [{"file": "a.log", "offset": 0}]}, "reason must be a non-empty"),
        ]
        path = self.temp / "malformed.json"
        for data, message in cases:
            with self.subTest(data=data):
                path.write_text(json.dumps(data), encoding="utf-8")
                with self.assertRaisesRegex(SecretScanError, message):
                    read_review(path)


class CredentialsTest(unittest.TestCase):
    def test_read_credentials_returns_the_named_values(self) -> None:
        environment = {
            "ANTHROPIC_API_KEY": "a-value",
            "OPENAI_API_KEY": "b-value",
            "OTHER": "c-value",
        }

        self.assertEqual(
            read_credentials(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"], environment),
            {"ANTHROPIC_API_KEY": "a-value", "OPENAI_API_KEY": "b-value"},
        )

    def test_a_missing_credential_names_the_variable_only(self) -> None:
        environment = {"ANTHROPIC_API_KEY": "sk-ant-other-secret"}

        with self.assertRaises(SecretScanError) as raised:
            read_credentials(["OPENAI_API_KEY"], environment)

        message = str(raised.exception)
        self.assertIn("OPENAI_API_KEY", message)
        self.assertIn("not set", message)
        self.assertNotIn("sk-ant-other-secret", message)

    def test_a_blank_credential_is_refused_without_its_value(self) -> None:
        environment = {"OPENAI_API_KEY": " \t "}

        with self.assertRaises(SecretScanError) as raised:
            read_credentials(["OPENAI_API_KEY"], environment)

        message = str(raised.exception)
        self.assertIn("OPENAI_API_KEY", message)
        self.assertIn("blank", message)
        self.assertNotIn(repr(environment["OPENAI_API_KEY"]), message)


class RecordTest(SecretScanTestCase):
    def test_scan_record_has_the_manifest_shape(self) -> None:
        self.write("a.log", "xx[REDACTED]")
        self.write("b.log", "key=sk-or-example")
        reason_a = "Harbor's scrubber wrote this"
        reason_b = "a documentation example"
        review = {
            (self.display("a.log"), 2): reason_a,
            (self.display("b.log"), 4): reason_b,
        }

        report = scan_roots([self.root], {"OPENAI_API_KEY": "s3cr3t-v4lue"}, review)

        self.assertEqual(
            scan_record(report),
            {
                "roots": [self.root.as_posix()],
                "patterns": {
                    "credentialVariables": ["OPENAI_API_KEY"],
                    "prefixes": list(KEY_PREFIXES),
                    "redactedMarker": REDACTED_MARKER,
                },
                "files": 2,
                "result": "passed",
                "explained": [
                    {"file": self.display("a.log"), "offset": 2, "reason": reason_a},
                    {"file": self.display("b.log"), "offset": 4, "reason": reason_b},
                ],
                "unexplained": 0,
            },
        )

    def test_the_report_and_record_never_contain_the_credential_value(self) -> None:
        value = "sk-ant-live-9f3"
        self.write("log.txt", f"token {value}\n")

        report = scan_roots([self.root], {"ANTHROPIC_API_KEY": value})

        text = report_text(report)
        record = json.dumps(scan_record(report))
        self.assertNotIn(value, text)
        self.assertNotIn(value, record)
        self.assertIn("ANTHROPIC_API_KEY", text)
        self.assertIn("ANTHROPIC_API_KEY", record)

    def test_report_text_lists_every_match_and_the_problems(self) -> None:
        self.write("a.log", "x [REDACTED]")
        self.write("b.log", "key=sk-proj-abc")
        review = {(self.display("a.log"), 2): "Harbor's scrubber", ("stale.log", 1): "old"}
        display_a = self.display("a.log")
        display_b = self.display("b.log")

        report = scan_roots([self.root], {}, review)

        text = report_text(report)
        self.assertIn(f"{display_a}:2: redacted [REDACTED] (explained: Harbor's scrubber)", text)
        self.assertIn(f"{display_b}:4: key-prefix sk-proj- (unexplained)", text)
        self.assertIn(
            "Scanned 2 files under 1 root: failed (1 unexplained match, 1 explanation problem)",
            text,
        )
        self.assertIn("Explanation problems:", text)
        self.assertIn("stale.log at offset 1", text)


class MainTest(SecretScanTestCase):
    def test_a_clean_scan_exits_0(self) -> None:
        code, stdout, stderr = self.run_main(str(self.root), environment={})

        self.assertEqual(code, 0)
        self.assertIn("Scanned 0 files under 1 root: passed", stdout)
        self.assertEqual(stderr, "")

    def test_an_unexplained_match_exits_1(self) -> None:
        self.write("log.txt", "[REDACTED]")

        code, stdout, _ = self.run_main(str(self.root), environment={})

        self.assertEqual(code, 1)
        self.assertIn("(unexplained)", stdout)
        self.assertIn("failed", stdout)

    def test_a_review_that_explains_every_match_exits_0(self) -> None:
        self.write("log.txt", "[REDACTED]")
        review = self.write_review(
            [{"file": self.display("log.txt"), "offset": 0, "reason": "Harbor's scrubber"}]
        )

        code, stdout, _ = self.run_main(str(self.root), "--review", str(review), environment={})

        self.assertEqual(code, 0)
        self.assertIn("passed", stdout)
        self.assertIn("explained: Harbor's scrubber", stdout)

    def test_a_secret_scan_error_exits_2(self) -> None:
        with self.subTest(case="missing credential"):
            code, stdout, stderr = self.run_main(
                str(self.root), "--credential", "OPENAI_API_KEY", environment={}
            )
            self.assertEqual(code, 2)
            self.assertEqual(stdout, "")
            self.assertIn("OPENAI_API_KEY", stderr)
        with self.subTest(case="missing root"):
            code, stdout, stderr = self.run_main(str(self.root / "missing"), environment={})
            self.assertEqual(code, 2)
            self.assertEqual(stdout, "")
            self.assertIn("does not exist", stderr)

    def test_an_unusable_command_line_exits_2(self) -> None:
        code, _, stderr = self.run_main(environment={})

        self.assertEqual(code, 2)
        self.assertIn("usage:", stderr)

    def test_the_json_option_writes_the_scan_record(self) -> None:
        self.write("log.txt", "[REDACTED]")
        output = self.temp / "scan.json"

        code, _, _ = self.run_main(
            str(self.root), "--json", str(output), environment={}
        )

        self.assertEqual(code, 1)
        record = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(record["roots"], [self.root.as_posix()])
        self.assertEqual(record["files"], 1)
        self.assertEqual(record["result"], "failed")
        self.assertEqual(record["unexplained"], 1)
        self.assertEqual(record["patterns"]["redactedMarker"], REDACTED_MARKER)
        self.assertEqual([path.name for path in self.temp.glob(".scan.json.*")], [])

    def test_a_failed_json_write_leaves_nothing(self) -> None:
        output = self.root / "record.json"
        output.mkdir()

        code, _, stderr = self.run_main(str(self.root), "--json", str(output), environment={})

        self.assertEqual(code, 2)
        self.assertIn("cannot write", stderr)
        self.assertTrue(output.is_dir())
        self.assertEqual([path.name for path in self.root.glob(".record.json.*")], [])

    def test_the_environment_defaults_to_os_environ(self) -> None:
        value = "default-environment-value"
        self.write("log.txt", f"token {value}")

        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": value}):
            code, stdout, _ = self.run_main(
                str(self.root), "--credential", "OPENAI_API_KEY"
            )

        self.assertEqual(code, 1)
        self.assertIn("OPENAI_API_KEY", stdout)
        self.assertNotIn(value, stdout)


if __name__ == "__main__":
    unittest.main()
