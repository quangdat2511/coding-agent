import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.factory import AgentFactory
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.models.trial.config import AgentConfig

from coding_agent_terminalbench.agent import CodingAgent
from coding_agent_terminalbench.manifest import ArtifactManifestError
from tests.support import COMMIT, manifest_data, write_manifest

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

    def test_install_and_run_fail_until_their_tickets_land(self) -> None:
        agent = self.create()
        environment = MagicMock()
        with self.assertRaisesRegex(NotImplementedError, "CDA-88"):
            asyncio.run(agent.install(environment))
        with self.assertRaisesRegex(NotImplementedError, "CDA-89"):
            asyncio.run(agent.run("instruction", environment, MagicMock()))


if __name__ == "__main__":
    unittest.main()
