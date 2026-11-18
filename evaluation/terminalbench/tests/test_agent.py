import asyncio
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.factory import AgentFactory
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory
from harbor.models.trial.config import AgentConfig

from coding_agent_terminalbench.agent import CodingAgent
from coding_agent_terminalbench.manifest import ArtifactManifestError
from tests.support import (
    COMMIT,
    DEFAULT,
    manifest_data,
    truncated_events,
    write_manifest,
    write_run_files,
)

IMPORT_PATH = "coding_agent_terminalbench.agent:CodingAgent"


class CodingAgentTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.logs_dir = self.root / "logs"
        self.artifact_dir = self.root / "artifact"
        write_manifest(self.artifact_dir, manifest_data())

    def create(self, **kwargs: object) -> CodingAgent:
        agent = AgentFactory.create_agent_from_import_path(
            IMPORT_PATH,
            logs_dir=self.logs_dir,
            model_name="opencode/some-model",
            **{"artifact_dir": str(self.artifact_dir), **kwargs},
        )
        self.assertIsInstance(agent, CodingAgent)
        assert isinstance(agent, CodingAgent)
        return agent

    def test_harbor_loads_the_class_from_its_import_path(self) -> None:
        self.assertEqual(CodingAgent.import_path(), IMPORT_PATH)
        self.assertTrue(issubclass(CodingAgent, BaseInstalledAgent))
        self.create()

    def test_the_agent_is_named_coding_agent(self) -> None:
        self.assertEqual(CodingAgent.name(), "coding-agent")
        self.assertEqual(self.create().to_agent_info().name, "coding-agent")

    def test_the_agent_declares_only_atif(self) -> None:
        self.assertEqual(CodingAgent.capabilities, AgentCapabilities(atif=True))
        # Harbor 0.23.0 keeps the deprecated flag in step with the declaration.
        self.assertTrue(CodingAgent.SUPPORTS_ATIF)

    def test_the_version_is_the_artifact_version_and_commit(self) -> None:
        agent = self.create()
        self.assertEqual(agent.version(), f"0.0.1 {COMMIT}")
        self.assertEqual(agent.to_agent_info().version, f"0.0.1 {COMMIT}")
        self.assertEqual(agent.manifest.version_line, f"coding-agent 0.0.1 {COMMIT}")

    def test_a_dirty_artifact_reports_its_dirty_commit(self) -> None:
        write_manifest(
            self.artifact_dir,
            manifest_data(
                codingAgent={"version": "0.0.1", "commit": f"{COMMIT}-dirty"},
                dirty=True,
            ),
        )
        self.assertEqual(self.create().version(), f"0.0.1 {COMMIT}-dirty")

    def test_a_version_kwarg_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "version: .*remove this kwarg"):
            self.create(version="9.9.9")

    def test_a_prompt_template_kwarg_is_refused(self) -> None:
        with self.assertRaisesRegex(
            ValueError, "prompt_template_path: .*runs Harbor's instruction verbatim"
        ):
            self.create(prompt_template_path="template.j2")

    def test_a_config_kwarg_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "config: .*reads no native config file"):
            self.create(config={"model": "x"})

    def test_the_artifact_dir_kwarg_is_required(self) -> None:
        with self.assertRaisesRegex(ValueError, "artifact_dir"):
            AgentFactory.create_agent_from_import_path(IMPORT_PATH, logs_dir=self.logs_dir)

    def test_an_unknown_kwarg_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unknown option 'artifact_path'"):
            self.create(artifact_path="dist/artifact")

    def test_a_missing_manifest_fails_construction(self) -> None:
        with self.assertRaisesRegex(ArtifactManifestError, "does not exist"):
            self.create(artifact_dir=str(self.root / "missing"))

    def test_preflight_checks_the_manifest_before_trials_are_queued(self) -> None:
        config = AgentConfig(
            import_path=IMPORT_PATH, kwargs={"artifact_dir": str(self.artifact_dir)}
        )
        AgentFactory.run_preflight(config)
        write_manifest(self.artifact_dir, manifest_data(schemaVersion=2))
        with self.assertRaisesRegex(ArtifactManifestError, "schemaVersion must be 1"):
            AgentFactory.run_preflight(config)
        missing = AgentConfig(import_path=IMPORT_PATH, kwargs={})
        with self.assertRaisesRegex(ValueError, "artifact_dir"):
            AgentFactory.run_preflight(missing)
        # The constructor refuses `config`, so preflight refuses it before any trial starts.
        with_config = AgentConfig(
            import_path=IMPORT_PATH,
            kwargs={"artifact_dir": str(self.artifact_dir), "config": "agent.json"},
        )
        with self.assertRaisesRegex(ValueError, "config: .*reads no native config file"):
            AgentFactory.run_preflight(with_config)

    def write_run(self, *, log: Any = DEFAULT, result: Any = DEFAULT) -> Path:
        """Writes a run and returns where Harbor expects the trajectory."""
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        write_run_files(self.logs_dir / "coding-agent", log=log, result=result)
        return self.logs_dir / "trajectory.json"

    def test_populate_context_post_run_fills_the_trial_and_writes_the_trajectory(self) -> None:
        agent = self.create()
        trajectory_path = self.write_run()
        context = AgentContext()

        agent.populate_context_post_run(context)

        self.assertEqual(context.n_input_tokens, 2_700)
        self.assertEqual(context.n_output_tokens, 80)
        self.assertEqual(context.n_cache_tokens, 1_000)
        self.assertIsNone(context.cost_usd)
        assert context.metadata is not None
        self.assertEqual(context.metadata["outcome"], "succeeded")
        self.assertEqual(context.metadata["profile"], "terminalbench")
        self.assertEqual(context.metadata["model_turns"], 2)
        self.assertEqual(context.metadata["tool_calls"], 1)
        self.assertEqual(
            context.metadata["artifact_sha256"],
            {"coding-agent-linux-x64": "a" * 64, "coding-agent-linux-arm64": "b" * 64},
        )
        # No install() ran in this test, so the metadata names no installed executable.
        self.assertNotIn("installed_executable", context.metadata)
        trajectory = Trajectory.model_validate_json(trajectory_path.read_text(encoding="utf-8"))
        self.assertEqual(trajectory.agent.name, "coding-agent")
        self.assertEqual(trajectory.agent.version, agent.version())
        self.assertEqual(len(trajectory.steps), 4)

    def test_populate_context_post_run_reads_a_truncated_log(self) -> None:
        agent = self.create()
        # result.json is absent, so the per-turn usage events are what the trial reports.
        self.write_run(log=truncated_events(), result=None)
        context = AgentContext()

        agent.populate_context_post_run(context)

        self.assertEqual(context.n_input_tokens, 1_200)
        assert context.metadata is not None
        self.assertTrue(context.metadata["truncated"])
        self.assertNotIn("outcome", context.metadata)

    def test_populate_context_post_run_leaves_the_context_empty_without_a_run(self) -> None:
        agent = self.create()
        context = AgentContext()

        with self.assertLogs(agent.logger, level="WARNING"):
            agent.populate_context_post_run(context)

        self.assertEqual(context, AgentContext())
        self.assertFalse((self.logs_dir / "trajectory.json").exists())

    def test_a_malformed_run_log_is_reported_instead_of_raised(self) -> None:
        agent = self.create()
        directory = self.logs_dir / "coding-agent"
        directory.mkdir(parents=True)
        (directory / "run.json").write_text("{", encoding="utf-8")
        context = AgentContext()

        with self.assertLogs(agent.logger, level="WARNING") as captured:
            agent.populate_context_post_run(context)

        self.assertEqual(context, AgentContext())
        self.assertFalse((self.logs_dir / "trajectory.json").exists())
        self.assertIn("the trial context and trajectory are incomplete", captured.output[0])

    def test_run_fails_until_its_ticket_lands(self) -> None:
        agent = self.create()
        with self.assertRaisesRegex(NotImplementedError, "CDA-89"):
            asyncio.run(agent.run("instruction", MagicMock(), MagicMock()))


if __name__ == "__main__":
    unittest.main()
