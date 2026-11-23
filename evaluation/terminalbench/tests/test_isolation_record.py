"""The Isolation Record: dated passing runs of the credential isolation test (ADR 0005 §7 item 3).

The record is a committed file. `add` writes one passing run into it with the date, and `check`
says whether it covers the backends of a job for one artifact.
"""

import io
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.isolation_record import main

from tests.support import COMMIT, manifest_data, write_manifest

OTHER_COMMIT = "0000000000000000000000000000000000000001"
SHA_X64 = "a" * 64
SHA_ARM64 = "b" * 64
DATASET = "example/dataset@1.0.0"
AMENDMENTS = (
    "ADR 0001 §7, the CDA-29 amendment of 2026-09-13 and the CDA-121 amendment of 2026-11-22"
)


def result(
    backend: str = "modal",
    uid: int = 0,
    passed: bool = True,
    commit: str = COMMIT,
    sha: str = SHA_X64,
    dataset: str = DATASET,
    task: str = "example-root-task",
) -> dict[str, Any]:
    """The parts of an isolation test result that the record reads."""
    return {
        "passed": passed,
        "failures": [] if passed else [{"code": "KEY_FOUND", "message": "found"}],
        "codingAgent": {"version": "0.0.1", "commit": commit},
        "executableSha256": sha,
        "dataset": dataset,
        "task": task,
        "backend": backend,
        "user": {"uid": uid, "name": "root" if uid == 0 else "agent"},
    }


class RecordTestCase(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.record = self.directory / "record.json"

    def run_cli(self, argv: list[str], day: date = date(2026, 11, 22)) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        code = main(argv, today=lambda: day, stdout=stdout, stderr=stderr)
        return code, stdout.getvalue(), stderr.getvalue()

    def add(
        self,
        document: dict[str, Any],
        day: date = date(2026, 11, 22),
        *,
        amendments: tuple[str, ...] = (AMENDMENTS,),
    ) -> tuple[int, str, str]:
        path = self.directory / f"result-{len(list(self.directory.iterdir()))}.json"
        path.write_text(json.dumps(document))
        argv = ["add", "--record", str(self.record), "--result", str(path)]
        for amendment in amendments:
            argv.extend(["--adr-amendment", amendment])
        return self.run_cli(argv, day)

    def runs(self) -> list[dict[str, Any]]:
        return json.loads(self.record.read_text())["runs"]


class AddTest(RecordTestCase):
    def test_a_passing_run_is_written_with_the_date_of_the_day_it_was_added(self) -> None:
        code, _, stderr = self.add(result(), date(2026, 11, 22))

        self.assertEqual(code, 0, stderr)
        document = json.loads(self.record.read_text())
        self.assertEqual(document["schemaVersion"], 1)
        self.assertEqual(document["codingAgent"], {"version": "0.0.1", "commit": COMMIT})
        self.assertEqual(document["runs"], [{"date": "2026-11-22", "result": result()}])

    def test_a_new_record_requires_explicit_amendments(self) -> None:
        code, _, stderr = self.add(result(), amendments=())

        self.assertEqual(code, 2, stderr)
        self.assertIn("--adr-amendment is required", stderr)
        self.assertFalse(self.record.exists())

    def test_a_new_record_keeps_its_explicit_amendments_when_more_runs_are_added(self) -> None:
        code, _, stderr = self.add(result())
        self.assertEqual(code, 0, stderr)
        code, _, stderr = self.add(result(backend="docker"), amendments=())
        self.assertEqual(code, 0, stderr)
        document = json.loads(self.record.read_text())
        self.assertEqual(document["adrAmendment"], AMENDMENTS)
        self.assertEqual([run["result"]["backend"] for run in document["runs"]], ["modal", "docker"])

    def test_a_matching_explicit_amendment_allows_another_run(self) -> None:
        code, _, stderr = self.add(result())
        self.assertEqual(code, 0, stderr)
        code, _, stderr = self.add(result(backend="docker", uid=1000))

        self.assertEqual(code, 0, stderr)
        self.assertEqual(self.runs()[1]["result"]["backend"], "docker")

    def test_amendments_are_trimmed_when_creating_and_comparing(self) -> None:
        code, _, stderr = self.add(result(), amendments=(f"  {AMENDMENTS}  ",))

        self.assertEqual(code, 0, stderr)
        self.assertEqual(json.loads(self.record.read_text())["adrAmendment"], AMENDMENTS)
        code, _, stderr = self.add(result(backend="docker"), amendments=(f"\t{AMENDMENTS} ",))
        self.assertEqual(code, 0, stderr)
        self.assertEqual(self.runs()[1]["result"]["backend"], "docker")

    def test_blank_amendments_are_a_usage_error(self) -> None:
        for amendment in ("", " \t "):
            with self.subTest(amendment=amendment):
                code, _, stderr = self.add(result(), amendments=(amendment,))
                self.assertEqual(code, 2, stderr)
                self.assertIn("--adr-amendment must not be blank", stderr)
                self.assertFalse(self.record.exists())

    def test_repeated_amendment_options_are_a_usage_error(self) -> None:
        code, _, stderr = self.add(result(), amendments=(AMENDMENTS, AMENDMENTS))

        self.assertEqual(code, 2, stderr)
        self.assertIn("--adr-amendment may only be specified once", stderr)
        self.assertFalse(self.record.exists())

    def test_an_explicit_amendment_cannot_relabel_an_existing_record(self) -> None:
        code, _, stderr = self.add(result())
        self.assertEqual(code, 0, stderr)
        original = self.record.read_bytes()
        other_amendments = "ADR 0001 §7, the CDA-29 amendment of 2026-09-13"

        code, _, stderr = self.add(result(backend="docker"), amendments=(other_amendments,))

        self.assertEqual(code, 1, stderr)
        self.assertIn("does not match the existing Isolation Record", stderr)
        self.assertIn(repr(AMENDMENTS), stderr)
        self.assertIn(repr(other_amendments), stderr)
        self.assertEqual(self.record.read_bytes(), original)

    def test_a_failed_run_is_refused_and_nothing_is_written(self) -> None:
        code, _, stderr = self.add(result(passed=False))

        self.assertEqual(code, 1)
        self.assertIn("did not pass", stderr)
        self.assertIn("Jira", stderr)
        self.assertFalse(self.record.exists())

    def test_a_second_run_is_added_after_the_first(self) -> None:
        self.add(result(backend="docker", uid=0), date(2026, 11, 22))

        code, _, _ = self.add(result(backend="docker", uid=1000), date(2026, 11, 23))

        self.assertEqual(code, 0)
        self.assertEqual(
            [(run["date"], run["result"]["user"]["uid"]) for run in self.runs()],
            [("2026-11-22", 0), ("2026-11-23", 1000)],
        )

    def test_a_result_that_is_not_an_isolation_test_result_is_refused(self) -> None:
        code, _, stderr = self.add({"passed": True})

        self.assertEqual(code, 1)
        self.assertIn("not an isolation test result", stderr)
        self.assertFalse(self.record.exists())

    def test_a_record_of_the_wrong_shape_is_refused_with_a_message_not_a_traceback(self) -> None:
        # A record can be edited by hand (PR #114 review).
        shapes = (
            {"runs": []},
            "x",
            [],
            {"codingAgent": {"version": "0.0.1", "commit": COMMIT}, "runs": 3},
        )
        for shape in shapes:
            with self.subTest(record=shape):
                self.record.write_text(json.dumps(shape))

                code, _, stderr = self.add(result())

                self.assertEqual(code, 1)
                self.assertIn("malformed", stderr)
                self.assertNotIn("Traceback", stderr)
                self.assertEqual(json.loads(self.record.read_text()), shape)

    def test_a_record_whose_coding_agent_has_no_commit_is_refused_without_a_traceback(self) -> None:
        # PR #114 review: the shape check passes it, and the refusal message must not read the
        # commit that it does not have.
        shape = {"codingAgent": {}, "runs": []}
        self.record.write_text(json.dumps(shape))

        code, _, stderr = self.add(result())

        self.assertEqual(code, 1)
        self.assertIn(COMMIT, stderr)
        self.assertNotIn("Traceback", stderr)
        self.assertEqual(json.loads(self.record.read_text()), shape)

    def test_a_run_of_another_commit_is_refused_and_the_record_is_unchanged(self) -> None:
        self.add(result())
        before = self.record.read_text()

        code, _, stderr = self.add(result(commit=OTHER_COMMIT))

        self.assertEqual(code, 1)
        self.assertIn(OTHER_COMMIT, stderr)
        self.assertIn(COMMIT, stderr)
        self.assertEqual(self.record.read_text(), before)


class CheckTest(RecordTestCase):
    """`check` is the one question that record.py and the smoke job ask: may this job start?"""

    def check(
        self,
        backends: list[str],
        dataset: str = DATASET,
        artifact: dict[str, Any] | None = None,
    ) -> tuple[int, str, str]:
        artifact_dir = self.directory / "artifact"
        write_manifest(artifact_dir, artifact if artifact is not None else manifest_data())
        argv = [
            "check",
            "--record",
            str(self.record),
            "--artifact-dir",
            str(artifact_dir),
            "--dataset",
            dataset,
        ]
        for backend in backends:
            argv += ["--backend", backend]
        return self.run_cli(argv)

    def add_root_and_non_root(self, backend: str, sha: str = SHA_X64) -> None:
        self.add(result(backend=backend, uid=0, sha=sha))
        self.add(result(backend=backend, uid=1000, sha=sha, task="example-non-root-task"))

    def test_a_record_with_a_root_and_a_non_root_run_for_each_backend_allows_the_job(self) -> None:
        self.add_root_and_non_root("modal", SHA_X64)
        self.add_root_and_non_root("docker", SHA_ARM64)

        code, _, stderr = self.check(["modal", "docker"])

        self.assertEqual((code, stderr), (0, ""))

    def test_a_backend_without_a_non_root_run_does_not_allow_the_job(self) -> None:
        self.add(result(backend="modal", uid=0))

        code, _, stderr = self.check(["modal"])

        self.assertEqual(code, 1)
        self.assertIn("modal", stderr)
        self.assertIn("non-root", stderr)

    def test_a_backend_that_the_record_does_not_name_does_not_allow_the_job(self) -> None:
        self.add_root_and_non_root("modal")

        code, _, stderr = self.check(["modal", "docker"])

        self.assertEqual(code, 1)
        self.assertIn("docker", stderr)
        self.assertNotIn("modal", stderr)

    def test_a_run_of_an_executable_that_the_artifact_does_not_hold_does_not_count(self) -> None:
        self.add_root_and_non_root("modal", sha="c" * 64)

        code, _, stderr = self.check(["modal"])

        self.assertEqual(code, 1)
        self.assertIn("SHA-256", stderr)

    def test_a_record_of_another_commit_does_not_allow_the_job(self) -> None:
        self.add_root_and_non_root("modal")
        other = manifest_data(codingAgent={"version": "0.0.1", "commit": OTHER_COMMIT})

        code, _, stderr = self.check(["modal"], artifact=other)

        self.assertEqual(code, 1)
        self.assertIn(OTHER_COMMIT, stderr)

    def test_a_run_on_another_dataset_does_not_allow_the_job(self) -> None:
        self.add_root_and_non_root("modal")

        code, _, stderr = self.check(["modal"], dataset="example/other@1.0.0")

        self.assertEqual(code, 1)
        self.assertIn("example/other@1.0.0", stderr)

    def test_a_run_that_did_not_pass_does_not_count_even_in_a_hand_edited_record(self) -> None:
        self.add_root_and_non_root("modal")
        document = json.loads(self.record.read_text())
        document["runs"][1]["result"]["passed"] = False
        self.record.write_text(json.dumps(document))

        code, _, stderr = self.check(["modal"])

        self.assertEqual(code, 1)
        self.assertIn("non-root", stderr)

    def test_a_backend_with_a_non_root_run_but_no_root_run_does_not_allow_the_job(self) -> None:
        # Written after the behavior existed, so it passed at once: a guard, not a red step.
        self.add(result(backend="modal", uid=1000))

        code, _, stderr = self.check(["modal"])

        self.assertEqual(code, 1)
        self.assertIn("as root", stderr)
        self.assertNotIn("non-root", stderr)

    def test_a_record_of_the_wrong_shape_is_refused_with_a_message_not_a_traceback(self) -> None:
        self.record.write_text(
            json.dumps({"schemaVersion": 1, "codingAgent": {"version": "0.0.1", "commit": COMMIT}})
        )

        code, _, stderr = self.check(["modal"])

        self.assertEqual(code, 1)
        self.assertIn("malformed", stderr)
        self.assertNotIn("Traceback", stderr)

    def test_a_missing_record_does_not_allow_the_job(self) -> None:
        code, _, stderr = self.check(["modal"])

        self.assertEqual(code, 1)
        self.assertIn("no Isolation Record", stderr)


if __name__ == "__main__":
    unittest.main()
