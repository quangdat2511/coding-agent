"""Reads run.json, events.jsonl and result.json (ADR 0005 §4)."""

import tempfile
import unittest
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.run_log import RunLog, RunLogError, load_run_log
from tests.support import (
    DEFAULT,
    OBJECTIVE,
    SESSION_ID,
    SYSTEM_PROMPT,
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
        # `coding-agent run --output-dir` writes here (ADR 0005 §6), and Harbor downloads this
        # directory with the logs of the trial.
        self.output_dir = Path(temp.name) / "logs" / "coding-agent"

    def read(
        self, *, record: Any = DEFAULT, log: Any = DEFAULT, result: Any = DEFAULT
    ) -> RunLog:
        """Writes a run, naming only the file a test changes, and reads it back."""
        write_run_files(self.output_dir, record=record, log=log, result=result)
        return load_run_log(self.output_dir)

    def test_reads_the_three_files_of_a_complete_run(self) -> None:
        log = self.read()

        self.assertEqual(log.record.system_prompt, SYSTEM_PROMPT)
        self.assertEqual(log.record.provider, "google")
        self.assertEqual(log.record.model, "gemini-3.5-flash-lite")
        self.assertEqual(log.record.profile, "terminalbench")
        self.assertEqual(log.session_id, SESSION_ID)
        self.assertFalse(log.truncated)
        self.assertEqual(log.model_turns, 2)
        self.assertEqual(log.tool_calls, 1)
        assert log.agent_result is not None
        self.assertEqual(log.agent_result["outcome"], "succeeded")
        self.assertEqual(len(log.events), 16)
        self.assertEqual(log.events[0].sequence, 1)
        self.assertEqual(log.events[0].type, "session_started")
        self.assertEqual(log.events[0].data["task"]["objective"], OBJECTIVE)
        self.assertEqual(log.events[0].occurred_at, "2026-11-12T00:00:00.000Z")
        self.assertEqual(log.events[-1].type, "session_settled")

    def test_a_log_that_does_not_end_with_session_settled_is_truncated(self) -> None:
        log = self.read(log=truncated_events(), result=None)

        self.assertTrue(log.truncated)
        self.assertIsNone(log.agent_result)
        self.assertEqual(len(log.events), 15)
        self.assertEqual(log.events[-1].type, "tool_execution_started")

    def test_a_partly_written_last_line_is_dropped(self) -> None:
        self.read(log=truncated_events())
        with (self.output_dir / "events.jsonl").open("a", encoding="utf-8") as file:
            file.write('{"schemaVersion": 1, "sessionId": "session-1", "sequence": 16, "oc')

        log = load_run_log(self.output_dir)

        self.assertEqual(len(log.events), 15)
        self.assertTrue(log.truncated)

    def test_characters_that_are_not_line_breaks_stay_inside_their_event(self) -> None:
        log = complete_events()
        # JSON.stringify writes these raw inside a string; none of them ends a line of JSON Lines.
        log[6]["data"]["result"]["content"] = "before\u2028middle\u0085after"
        self.read(log=log)

        text = (self.output_dir / "events.jsonl").read_text(encoding="utf-8")
        self.assertIn("\u2028", text)
        read = load_run_log(self.output_dir)
        self.assertEqual(len(read.events), 16)
        self.assertFalse(read.truncated)
        self.assertEqual(
            read.events[6].data["result"]["content"], "before\u2028middle\u0085after"
        )

    def test_a_missing_result_json_leaves_the_settled_result(self) -> None:
        log = self.read(result=None)

        self.assertFalse(log.truncated)
        assert log.agent_result is not None
        self.assertEqual(log.agent_result["outcome"], "succeeded")
        self.assertEqual(log.agent_result["usage"]["inputTokens"], 2_700)

    def test_a_missing_events_file_is_an_empty_truncated_log(self) -> None:
        log = self.read(log=None)

        self.assertEqual(log.events, ())
        self.assertTrue(log.truncated)
        assert log.agent_result is not None
        self.assertEqual(log.agent_result["outcome"], "succeeded")

    def test_a_missing_run_json_names_the_output_dir(self) -> None:
        with self.assertRaisesRegex(RunLogError, r"run\.json does not exist.*--output-dir"):
            self.read(record=None)

    def test_invalid_json_in_run_json_is_refused(self) -> None:
        write_run_files(self.output_dir, record=None)
        (self.output_dir / "run.json").write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(RunLogError, r"run\.json is not valid JSON"):
            load_run_log(self.output_dir)

    def test_another_schema_version_is_refused(self) -> None:
        with self.subTest(file="run.json"):
            with self.assertRaisesRegex(
                RunLogError, r"run\.json: schemaVersion must be 1, found 2"
            ):
                self.read(record=run_record_data(schemaVersion=2))

        with self.subTest(file="result.json"):
            result = {**result_record_data({"outcome": "succeeded"}), "schemaVersion": 2}
            with self.assertRaisesRegex(
                RunLogError, r"result\.json: schemaVersion must be 1, found 2"
            ):
                self.read(result=result)

        with self.subTest(file="events.jsonl"):
            log = complete_events()
            log[0] = {**log[0], "schemaVersion": 2}
            with self.assertRaisesRegex(
                RunLogError, r"events\.jsonl line 1: schemaVersion must be 1, found 2"
            ):
                self.read(log=log)

    def test_a_record_without_a_system_prompt_is_refused(self) -> None:
        with self.assertRaisesRegex(RunLogError, "systemPrompt must be a string"):
            self.read(record=run_record_data(systemPrompt=None))

    def test_an_events_file_that_is_not_a_log_of_objects_is_read_as_a_truncated_tail(self) -> None:
        write_run_files(self.output_dir)
        (self.output_dir / "events.jsonl").write_text("[1, 2, 3]\n", encoding="utf-8")

        log = load_run_log(self.output_dir)

        self.assertEqual(log.events, ())
        self.assertTrue(log.truncated)

    def test_the_usage_comes_from_the_agent_result(self) -> None:
        log = self.read()

        self.assertEqual(log.usage.input, 2_700)
        self.assertEqual(log.usage.output, 80)
        self.assertEqual(log.usage.cached, 1_000)

    def test_a_truncated_log_sums_the_usage_of_its_model_turns(self) -> None:
        log = self.read(log=truncated_events(), result=None)

        self.assertEqual(log.usage.input, 1_200)
        self.assertEqual(log.usage.output, 48)
        self.assertEqual(log.usage.cached, 1_000)

    def test_a_count_that_no_provider_recorded_stays_absent(self) -> None:
        log = complete_events()
        for index, event in enumerate(log):
            if event["type"] == "model_turn_completed":
                log[index] = {**event, "data": {**event["data"], "usage": {"inputTokens": 7}}}
        # The session never settled, so the log has no Agent Result to take the counts from.
        truncation = self.read(log=log[:-1], result=None)

        self.assertEqual(truncation.usage.input, 14)
        self.assertIsNone(truncation.usage.output)
        self.assertIsNone(truncation.usage.cached)


if __name__ == "__main__":
    unittest.main()
