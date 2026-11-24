"""Converts the event log into an ATIF trajectory (ADR 0005 §6)."""

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from harbor.models.trajectories import Trajectory

from coding_agent_terminalbench.run_log import load_run_log
from coding_agent_terminalbench.trajectory import (
    AgentIdentity,
    build_trajectory,
    write_trajectory,
)
from tests.support import (
    CALL_1,
    CALL_2,
    COMMIT,
    DEFAULT,
    FEEDBACK,
    FINAL_TEXT,
    OBJECTIVE,
    OCCURRED_AT,
    RUN_ID,
    SYSTEM_PROMPT,
    agent_result,
    cancelled_events,
    complete_events,
    failed_events,
    feedback_events,
    truncated_events,
    write_run_files,
)

AGENT = AgentIdentity(name="coding-agent", version=f"0.0.1 {COMMIT}")


class TrajectoryTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.output_dir = self.root / "coding-agent"

    def build(
        self, *, record: Any = DEFAULT, log: Any = DEFAULT, result: Any = DEFAULT
    ) -> Trajectory:
        """Writes a run, naming only the file a test changes, and converts it."""
        write_run_files(self.output_dir, record=record, log=log, result=result)
        return build_trajectory(load_run_log(self.output_dir), agent=AGENT)

    def assert_validates(self, trajectory: Trajectory) -> dict[str, Any]:
        path = self.root / "trajectory.json"
        write_trajectory(path, trajectory)
        self.assertFalse(path.with_name(f"{path.name}.partial").exists())
        text = path.read_text(encoding="utf-8")
        Trajectory.model_validate_json(text)
        data: dict[str, Any] = json.loads(text)
        return data

    def test_maps_the_system_prompt_the_task_and_each_assistant_message(self) -> None:
        trajectory = self.build()

        self.assertEqual(
            [step.source for step in trajectory.steps], ["system", "user", "agent", "agent"]
        )
        self.assertEqual([step.step_id for step in trajectory.steps], [1, 2, 3, 4])
        self.assertEqual(trajectory.steps[0].message, SYSTEM_PROMPT)
        self.assertEqual(trajectory.steps[1].message, OBJECTIVE)
        self.assertEqual(trajectory.steps[2].message, "Reading the parser.")
        self.assertEqual(trajectory.steps[3].message, FINAL_TEXT)

    def test_each_step_carries_the_time_of_its_event(self) -> None:
        trajectory = self.build()

        self.assertIsNone(trajectory.steps[0].timestamp)
        self.assertEqual(trajectory.steps[1].timestamp, OCCURRED_AT)
        self.assertEqual(trajectory.steps[2].timestamp, OCCURRED_AT)

    def test_names_the_agent_and_the_model(self) -> None:
        trajectory = self.build()

        self.assertEqual(trajectory.agent.name, "coding-agent")
        self.assertEqual(trajectory.agent.version, f"0.0.1 {COMMIT}")
        self.assertEqual(trajectory.agent.model_name, "google/gemini-3.5-flash-lite")
        self.assertEqual(trajectory.session_id, RUN_ID)

    def test_keys_a_tool_call_by_its_agent_core_id_and_answers_it_on_its_own_step(self) -> None:
        trajectory = self.build()

        calls = trajectory.steps[2].tool_calls
        assert calls is not None
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].tool_call_id, CALL_1)
        self.assertEqual(calls[0].function_name, "read")
        self.assertEqual(calls[0].arguments, {"path": "src/parser.py"})
        assert trajectory.steps[2].observation is not None
        results = trajectory.steps[2].observation.results
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].source_call_id, CALL_1)
        self.assertEqual(results[0].content, "def parse(arguments):\n")
        self.assertEqual(results[0].extra, {"outcome": "succeeded"})
        self.assertIsNone(trajectory.steps[3].observation)

    def test_each_model_turns_usage_becomes_the_metrics_of_its_step(self) -> None:
        trajectory = self.build()

        first = trajectory.steps[2].metrics
        assert first is not None
        self.assertEqual(first.prompt_tokens, 1_200)
        self.assertEqual(first.completion_tokens, 48)
        self.assertEqual(first.cached_tokens, 1_000)
        self.assertIsNone(first.cost_usd)
        second = trajectory.steps[3].metrics
        assert second is not None
        self.assertEqual(second.prompt_tokens, 1_500)
        self.assertEqual(second.completion_tokens, 32)
        self.assertIsNone(second.cached_tokens)
        self.assertIsNone(first.extra)

    def test_the_agent_result_fills_the_final_metrics(self) -> None:
        trajectory = self.build()

        final = trajectory.final_metrics
        assert final is not None
        self.assertEqual(final.total_prompt_tokens, 2_700)
        self.assertEqual(final.total_completion_tokens, 80)
        self.assertEqual(final.total_cached_tokens, 1_000)
        self.assertIsNone(final.total_cost_usd)
        self.assertEqual(final.total_steps, 4)
        self.assertEqual(final.extra, {"outcome": "succeeded"})

    def test_a_complete_log_writes_a_document_that_harbor_accepts(self) -> None:
        data = self.assert_validates(self.build())

        # The document follows the ATIF version that Harbor's model defaults to, so upgrading the
        # Harbor pin moves both together.
        self.assertEqual(
            data["schema_version"], Trajectory.model_fields["schema_version"].default
        )
        self.assertEqual(
            [step["source"] for step in data["steps"]], ["system", "user", "agent", "agent"]
        )
        self.assertNotIn("cost_usd", json.dumps(data))

    def test_a_truncated_log_still_converts_and_validates(self) -> None:
        trajectory = self.build(log=truncated_events(), result=None)
        data = self.assert_validates(trajectory)

        self.assertEqual(
            [step.source for step in trajectory.steps], ["system", "user", "agent", "agent"]
        )
        self.assertEqual(trajectory.steps[3].message, "Writing the fix.")
        calls = trajectory.steps[3].tool_calls
        assert calls is not None
        self.assertEqual(calls[0].tool_call_id, CALL_2)
        self.assertEqual(calls[0].function_name, "write")
        # The Tool Call never returned, and the Model Turn never completed.
        self.assertIsNone(trajectory.steps[3].observation)
        self.assertIsNone(trajectory.steps[3].metrics)
        final = trajectory.final_metrics
        assert final is not None
        self.assertEqual(final.total_prompt_tokens, 1_200)
        self.assertEqual(final.total_completion_tokens, 48)
        self.assertEqual(final.total_cached_tokens, 1_000)
        self.assertIsNone(final.total_cost_usd)
        self.assertEqual(final.extra, {"truncated": True})
        self.assertEqual(len(data["steps"]), 4)

    def test_verification_feedback_becomes_a_user_step(self) -> None:
        trajectory = self.build(log=feedback_events())

        self.assertEqual(
            [step.source for step in trajectory.steps], ["system", "user", "agent", "user", "agent"]
        )
        self.assertEqual(trajectory.steps[3].message, FEEDBACK)
        self.assertIsNone(trajectory.steps[3].tool_calls)
        self.assert_validates(trajectory)

    def test_a_cancelled_tool_call_keeps_its_outcome_without_a_tool_result(self) -> None:
        trajectory = self.build(log=cancelled_events(), result=None)

        calls = trajectory.steps[2].tool_calls
        assert calls is not None
        self.assertEqual(calls[0].tool_call_id, CALL_1)
        assert trajectory.steps[2].observation is not None
        result = trajectory.steps[2].observation.results[0]
        self.assertEqual(result.source_call_id, CALL_1)
        self.assertIsNone(result.content)
        self.assertEqual(result.extra, {"outcome": "cancelled"})
        final = trajectory.final_metrics
        assert final is not None
        self.assertEqual(
            final.extra, {"outcome": "cancelled", "cancellation": {"reason": "SIGINT"}}
        )
        self.assert_validates(trajectory)

    def test_a_skipped_tool_call_records_the_reason(self) -> None:
        log = complete_events()
        log[6] = {
            "schemaVersion": 1,
            "runId": RUN_ID,
            "sequence": 7,
            "occurredAt": OCCURRED_AT,
            "type": "tool_call_completed",
            "data": {"toolCallId": CALL_1, "outcome": "skipped", "reason": "CANCELLED"},
        }
        trajectory = self.build(log=log)

        assert trajectory.steps[2].observation is not None
        result = trajectory.steps[2].observation.results[0]
        self.assertIsNone(result.content)
        self.assertEqual(result.extra, {"outcome": "skipped", "reason": "CANCELLED"})

    def test_a_failed_assistant_message_records_its_failure(self) -> None:
        trajectory = self.build(log=failed_events(), result=None)

        self.assertEqual([step.source for step in trajectory.steps], ["system", "user", "agent"])
        step = trajectory.steps[2]
        self.assertEqual(step.message, "Writing the fi")
        self.assertEqual(
            step.extra,
            {
                "outcome": "failed",
                "failure": {"code": "MODEL_FAILURE", "message": "the provider returned 503"},
            },
        )
        final = trajectory.final_metrics
        assert final is not None
        self.assertEqual(final.extra["outcome"], "failed")
        self.assert_validates(trajectory)

    def test_arguments_that_are_not_a_json_object_are_kept_verbatim(self) -> None:
        log = complete_events()
        message = log[3]["data"]["message"]
        message["content"] = [
            {"type": "text", "text": "Reading the parser."},
            {
                "type": "tool_call",
                "toolCallId": "provider_call_a",
                "name": "read",
                "arguments": "not json",
            },
        ]
        trajectory = self.build(log=log)

        calls = trajectory.steps[2].tool_calls
        assert calls is not None
        self.assertEqual(calls[0].arguments, {"raw": "not json"})

    def test_a_message_with_no_text_keeps_its_tool_calls(self) -> None:
        log = complete_events()
        log[3]["data"]["message"]["content"] = [
            {
                "type": "tool_call",
                "toolCallId": "provider_call_a",
                "name": "read",
                "arguments": '{"path": "a"}',
            }
        ]
        trajectory = self.build(log=log)
        self.assert_validates(trajectory)

        self.assertEqual(trajectory.steps[2].message, "")
        calls = trajectory.steps[2].tool_calls
        assert calls is not None
        self.assertEqual(calls[0].tool_call_id, CALL_1)

    def test_a_log_with_no_events_is_only_the_system_prompt(self) -> None:
        trajectory = self.build(log=[], result=None)

        self.assertEqual([step.source for step in trajectory.steps], ["system"])
        self.assertEqual(trajectory.steps[0].message, SYSTEM_PROMPT)
        self.assertIsNone(trajectory.session_id)
        final = trajectory.final_metrics
        assert final is not None
        self.assertEqual(final.extra, {"truncated": True})
        self.assert_validates(trajectory)

    def test_a_failed_verification_is_not_a_user_step(self) -> None:
        log = complete_events()
        log[14]["data"] = {
            "verificationId": "verification-1",
            "outcome": "failed",
            "evidence": [],
        }
        log[15] = {
            "schemaVersion": 1,
            "runId": RUN_ID,
            "sequence": 16,
            "occurredAt": OCCURRED_AT,
            "type": "run_settled",
            "data": {
                "result": agent_result(
                    outcome="failed",
                    failure={"code": "VERIFICATION_FAILED", "message": "the tests fail"},
                )
            },
        }
        trajectory = self.build(log=log, result=None)

        self.assertEqual(
            [step.source for step in trajectory.steps], ["system", "user", "agent", "agent"]
        )
        final = trajectory.final_metrics
        assert final is not None
        self.assertEqual(final.extra["failure"]["code"], "VERIFICATION_FAILED")


if __name__ == "__main__":
    unittest.main()
