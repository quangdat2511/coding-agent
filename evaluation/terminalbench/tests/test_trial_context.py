"""Fills the Harbor Agent Context from the files of a run (ADR 0005 §6)."""

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory

from coding_agent_terminalbench.run_log import RunLogError
from coding_agent_terminalbench.trajectory import AgentIdentity
from coding_agent_terminalbench.trial_context import populate_trial_context
from tests.support import (
    COMMIT,
    DEFAULT,
    OCCURRED_AT,
    RUN_ID,
    complete_events,
    failed_events,
    truncated_events,
    write_run_files,
)

AGENT = AgentIdentity(name="coding-agent", version=f"0.0.1 {COMMIT}")

ARTIFACT_SHA256 = {"coding-agent-linux-x64": "a" * 64}


class PopulateTrialContextTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs_dir = self.root / "logs"
        self.run_dir = self.logs_dir / "coding-agent"
        self.trajectory_path = self.logs_dir / "trajectory.json"
        self.context = AgentContext()

    def populate(
        self, *, record: Any = DEFAULT, log: Any = DEFAULT, result: Any = DEFAULT
    ) -> AgentContext:
        """Writes a run, naming only the file a test changes, and fills the context from it."""
        write_run_files(self.run_dir, record=record, log=log, result=result)
        populate_trial_context(
            self.context,
            self.run_dir,
            trajectory_path=self.trajectory_path,
            agent=AGENT,
            artifact_sha256=ARTIFACT_SHA256,
        )
        return self.context

    def trajectory(self) -> Trajectory:
        return Trajectory.model_validate_json(self.trajectory_path.read_text(encoding="utf-8"))

    def test_fills_the_token_counts_from_the_agent_result(self) -> None:
        context = self.populate()

        self.assertEqual(context.n_input_tokens, 2_700)
        self.assertEqual(context.n_output_tokens, 80)
        self.assertEqual(context.n_cache_tokens, 1_000)
        # ADR 0005 §6 leaves the cost unset, because the provider contract carries no pricing.
        self.assertIsNone(context.cost_usd)

    def test_fills_the_metadata_that_names_the_run(self) -> None:
        context = self.populate()

        self.assertEqual(
            context.metadata,
            {
                "outcome": "succeeded",
                "model_turns": 2,
                "tool_calls": 1,
                "profile": "terminalbench",
                "artifact_sha256": ARTIFACT_SHA256,
                "truncated": False,
            },
        )

    def test_a_truncated_log_takes_its_tokens_from_the_model_turns(self) -> None:
        context = self.populate(log=truncated_events(), result=None)

        self.assertEqual(context.n_input_tokens, 1_200)
        self.assertEqual(context.n_output_tokens, 48)
        self.assertEqual(context.n_cache_tokens, 1_000)
        assert context.metadata is not None
        self.assertTrue(context.metadata["truncated"])
        self.assertNotIn("outcome", context.metadata)
        self.assertNotIn("failure_code", context.metadata)

    def test_a_failed_run_names_its_failure_code(self) -> None:
        context = self.populate(log=failed_events(), result=None)

        assert context.metadata is not None
        self.assertEqual(context.metadata["outcome"], "failed")
        self.assertEqual(context.metadata["failure_code"], "MODEL_FAILURE")

    def test_a_runtime_limit_that_ended_the_agent_run_is_named(self) -> None:
        log = complete_events()
        log.insert(
            len(log) - 1,
            {
                "schemaVersion": 2,
                "runId": RUN_ID,
                "sequence": 16,
                "occurredAt": OCCURRED_AT,
                "type": "runtime_limit_reached",
                "data": {"kind": "maxModelTurns", "limit": 250, "observed": 251},
            },
        )
        context = self.populate(log=log)

        assert context.metadata is not None
        self.assertEqual(
            context.metadata["limit_reached"],
            {"kind": "maxModelTurns", "limit": 250, "observed": 251},
        )

    def test_writes_a_trajectory_that_harbor_accepts(self) -> None:
        self.populate()

        trajectory = self.trajectory()
        self.assertEqual(trajectory.agent.name, "coding-agent")
        self.assertEqual(trajectory.agent.version, AGENT.version)
        self.assertEqual(trajectory.session_id, RUN_ID)
        written = json.loads(self.trajectory_path.read_text(encoding="utf-8"))
        self.assertEqual(written["steps"][0]["source"], "system")

    def test_writes_the_trajectory_beside_the_directory_of_the_run(self) -> None:
        self.populate()

        self.assertEqual(
            sorted(path.name for path in self.logs_dir.iterdir()),
            ["coding-agent", "trajectory.json"],
        )

    def test_a_missing_run_log_is_raised_for_the_agent_to_report(self) -> None:
        with self.assertRaisesRegex(RunLogError, r"run\.json does not exist"):
            populate_trial_context(
                self.context,
                self.run_dir,
                trajectory_path=self.trajectory_path,
                agent=AGENT,
                artifact_sha256=ARTIFACT_SHA256,
            )
        self.assertEqual(self.context, AgentContext())
        self.assertFalse(self.trajectory_path.exists())


if __name__ == "__main__":
    unittest.main()
