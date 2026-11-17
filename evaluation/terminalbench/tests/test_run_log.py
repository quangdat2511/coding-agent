"""Reads run.json, events.jsonl and result.json (ADR 0005 §4)."""

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.run_log import RunLogError, load_run_log
from tests.support import (
    OBJECTIVE,
    SESSION_ID,
    SYSTEM_PROMPT,
    agent_result,
    complete_events,
    result_record_data,
    run_record_data,
    truncated_events,
    write_run_files,
)


class RunLogTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        # `coding-agent run --output-dir` writes here (ADR 0005 §6), and Harbor downloads the
        # logs directory with this directory inside it.
        self.output_dir = Path(temp.name) / "logs" / "coding-agent"

    def write(
        self,
        *,
        record: dict[str, Any] | None = None,
        log: list[dict[str, Any]] | None = None,
        result: dict[str, Any] | None = None,
    ) -> None:
        write_run_files(
            self.output_dir,
            record=run_record_data() if record is None else record,
            log=complete_events() if log is None else log,
            result=result_record_data(agent_result()) if result is None else result,
        )

    def test_reads_the_three_files_of_a_complete_run(self) -> None:
        self.write()
        log = load_run_log(self.output_dir)

        self.assertEqual(log.record.system_prompt, SYSTEM_PROMPT)
        self.assertEqual(log.record.provider, "google")
        self.assertEqual(log.record.model, "gemini-3.5-flash-lite")
        self.assertEqual(log.record.profile, "terminalbench")
        self.assertEqual(log.record.tool_names, ("read", "write", "edit", "bash"))
        self.assertEqual(log.session_id, SESSION_ID)
        self.assertFalse(log.truncated)
        assert log.agent_result is not None
        self.assertEqual(log.agent_result["outcome"], "succeeded")
        self.assertEqual(len(log.events), 16)
        self.assertEqual(log.events[0].sequence, 1)
        self.assertEqual(log.events[0].type, "session_started")
        self.assertEqual(log.events[0].data["task"]["objective"], OBJECTIVE)
        self.assertEqual(log.events[0].occurred_at, "2026-11-12T00:00:00.000Z")
        self.assertEqual(log.events[-1].type, "session_settled")

    def test_a_log_that_does_not_end_with_session_settled_is_truncated(self) -> None:
        write_run_files(
            self.output_dir,
            record=run_record_data(),
            log=truncated_events(),
        )
        log = load_run_log(self.output_dir)

        self.assertTrue(log.truncated)
        self.assertIsNone(log.agent_result)
        self.assertEqual(len(log.events), 15)
        self.assertEqual(log.events[-1].type, "tool_execution_started")

    def test_a_partly_written_last_line_is_dropped(self) -> None:
        self.write(log=truncated_events())
        with (self.output_dir / "events.jsonl").open("a", encoding="utf-8") as file:
            file.write('{"schemaVersion": 1, "sessionId": "session-1", "sequence": 16, "oc')

        log = load_run_log(self.output_dir)

        self.assertEqual(len(log.events), 15)
        self.assertTrue(log.truncated)

    def test_a_missing_result_json_leaves_the_settled_result(self) -> None:
        write_run_files(
            self.output_dir,
            record=run_record_data(),
            log=complete_events(),
        )
        log = load_run_log(self.output_dir)

        self.assertFalse(log.truncated)
        assert log.agent_result is not None
        self.assertEqual(log.agent_result["outcome"], "succeeded")
        self.assertEqual(log.agent_result["usage"]["inputTokens"], 2_700)

    def test_a_missing_events_file_is_an_empty_truncated_log(self) -> None:
        write_run_files(
            self.output_dir,
            record=run_record_data(),
            result=result_record_data(agent_result()),
        )
        log = load_run_log(self.output_dir)

        self.assertEqual(log.events, ())
        self.assertTrue(log.truncated)
        assert log.agent_result is not None
        self.assertEqual(log.agent_result["outcome"], "succeeded")

    def test_a_missing_run_json_names_the_output_dir(self) -> None:
        with self.assertRaisesRegex(RunLogError, r"run\.json does not exist.*--output-dir"):
            load_run_log(self.output_dir)

    def test_invalid_json_in_run_json_is_refused(self) -> None:
        self.output_dir.mkdir(parents=True)
        (self.output_dir / "run.json").write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(RunLogError, "run.json is not valid JSON"):
            load_run_log(self.output_dir)

    def test_another_schema_version_is_refused(self) -> None:
        with self.subTest(file="run.json"):
            self.write(record=run_record_data(schemaVersion=2))
            with self.assertRaisesRegex(
                RunLogError, "run\\.json: schemaVersion must be 1, found 2"
            ):
                load_run_log(self.output_dir)

        with self.subTest(file="result.json"):
            self.write(result={**result_record_data(agent_result()), "schemaVersion": 2})
            with self.assertRaisesRegex(
                RunLogError, "result\\.json: schemaVersion must be 1, found 2"
            ):
                load_run_log(self.output_dir)

        with self.subTest(file="events.jsonl"):
            log = complete_events()
            log[0] = {**log[0], "schemaVersion": 2}
            self.write(log=log)
            with self.assertRaisesRegex(
                RunLogError, "events\\.jsonl line 1: schemaVersion must be 1, found 2"
            ):
                load_run_log(self.output_dir)

    def test_a_record_without_a_system_prompt_is_refused(self) -> None:
        self.write(record=run_record_data(systemPrompt=None))
        with self.assertRaisesRegex(RunLogError, "systemPrompt must be a string"):
            load_run_log(self.output_dir)

    def test_an_events_file_that_is_not_a_log_of_objects_is_read_as_a_truncated_tail(self) -> None:
        self.output_dir.mkdir(parents=True)
        (self.output_dir / "run.json").write_text(
            json.dumps(run_record_data()), encoding="utf-8"
        )
        (self.output_dir / "events.jsonl").write_text("[1, 2, 3]\n", encoding="utf-8")

        log = load_run_log(self.output_dir)

        self.assertEqual(log.events, ())
        self.assertTrue(log.truncated)


if __name__ == "__main__":
    unittest.main()
