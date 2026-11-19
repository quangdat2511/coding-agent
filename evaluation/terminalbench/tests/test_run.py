"""run() through a fake environment that records every upload and exec (ADR 0005 §6)."""

import asyncio
import os
import shlex
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from unittest.mock import patch

from harbor.agents.factory import AgentFactory
from harbor.agents.installed.base import AgentAuthenticationError, NonZeroAgentExitCodeError
from harbor.environments.base import ExecResult
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import MCPServerConfig

from coding_agent_terminalbench.agent import CodingAgent
from coding_agent_terminalbench.launch import INSTRUCTION_PATH
from tests.support import IMPORT_PATH, PROVIDER_KEY, manifest_data, write_manifest


# The ADR 0005 §6 command for `-m opencode/deepseek-v4.1-flash` in a single-agent trial.
ADR_COMMAND = (
    "exec /installed-agent/coding-agent run --task-file /installed-agent/instruction.md "
    "--provider opencode --model deepseek-v4.1-flash --approval-policy auto-approve "
    "--profile terminalbench --output-dir /logs/agent/coding-agent"
)

CHOWN = f"set -o pipefail; chown agent {INSTRUCTION_PATH}"


@dataclass(frozen=True)
class Exec:
    command: str
    cwd: str | None
    env: dict[str, str] | None
    timeout_sec: int | None
    user: str | int | None


class FakeEnvironment:
    """Records what run() sends to the container. The agent command exits with `return_code`."""

    def __init__(
        self,
        return_code: int = 0,
        stderr: str | None = None,
        default_user: str | None = "agent",
    ) -> None:
        self.return_code = return_code
        self.stderr = stderr
        self.default_user = default_user
        self.execs: list[Exec] = []
        self.uploads: list[tuple[str, bytes]] = []

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        # run() deletes the source after the upload, so the content is read now.
        self.uploads.append((target_path, Path(source_path).read_bytes()))

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        self.execs.append(Exec(command, cwd, env, timeout_sec, user))
        if command.startswith("exec "):
            return ExecResult(return_code=self.return_code, stdout="", stderr=self.stderr)
        return ExecResult(return_code=0, stdout="", stderr="")

    def agent_exec(self) -> Exec:
        launches = [call for call in self.execs if call.command.startswith("exec ")]
        assert len(launches) == 1, launches
        return launches[0]


class RunTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.artifact_dir = self.root / "artifact"
        write_manifest(self.artifact_dir, manifest_data())
        host_env = patch.dict(
            os.environ,
            {"OPENCODE_API_KEY": PROVIDER_KEY, "OPENROUTER_API_KEY": PROVIDER_KEY},
        )
        host_env.start()
        self.addCleanup(host_env.stop)

    def create(
        self,
        model_name: str = "opencode/deepseek-v4.1-flash",
        key_variable: str = "OPENCODE_API_KEY",
        **kwargs: object,
    ) -> CodingAgent:
        agent = AgentFactory.create_agent_from_import_path(
            IMPORT_PATH,
            logs_dir=self.root / "logs",
            model_name=model_name,
            extra_env={key_variable: PROVIDER_KEY},
            artifact_dir=str(self.artifact_dir),
            **kwargs,
        )
        assert isinstance(agent, CodingAgent)
        return agent

    def run_agent(
        self,
        environment: FakeEnvironment,
        instruction: str = "Fix the build.\n",
        agent: CodingAgent | None = None,
        context: AgentContext | None = None,
    ) -> None:
        agent = agent or self.create()
        asyncio.run(agent.run(instruction, environment, context or AgentContext()))  # type: ignore[arg-type]

    def test_the_instruction_is_uploaded_verbatim(self) -> None:
        instruction = (
            "# Task\r\n\nUse `$HOME` and \"quotes\", not {{ template }}.\n\t  trailing  \n"
            "Unicode: naïve café 日本語   end"
        )
        environment = FakeEnvironment()
        self.run_agent(environment, instruction)
        self.assertEqual(environment.uploads, [(INSTRUCTION_PATH, instruction.encode("utf-8"))])

    def test_the_instruction_belongs_to_the_agent_user(self) -> None:
        environment = FakeEnvironment()
        self.run_agent(environment)
        self.assertEqual(
            environment.execs[0],
            Exec(command=CHOWN, cwd=None, env=None, timeout_sec=None, user="root"),
        )
        # When the agent runs as the container's default user, nothing is chowned.
        as_root = FakeEnvironment(default_user=None)
        self.run_agent(as_root)
        self.assertEqual([call.command for call in as_root.execs], [ADR_COMMAND])

    def test_no_mcp_server_or_skill_reaches_the_agent(self) -> None:
        agent = self.create(
            mcp_servers=[MCPServerConfig(name="search", transport="stdio", command="search-mcp")],
            skills_dir="/task/skills",
        )
        environment = FakeEnvironment()
        self.run_agent(environment, "Do it.", agent=agent)
        self.assertEqual([target for target, _ in environment.uploads], [INSTRUCTION_PATH])
        self.assertEqual([call.command for call in environment.execs], [CHOWN, ADR_COMMAND])

    def test_the_command_is_the_adr_command(self) -> None:
        environment = FakeEnvironment()
        self.run_agent(environment)
        self.assertEqual(
            environment.agent_exec(),
            Exec(command=ADR_COMMAND, cwd=None, env=None, timeout_sec=None, user=None),
        )

    def test_the_command_execs_the_agent_without_a_pipeline(self) -> None:
        environment = FakeEnvironment()
        self.run_agent(environment)
        command = environment.agent_exec().command
        tokens = shlex.split(command)
        self.assertEqual(tokens[0], "exec")
        self.assertEqual(tokens[1], "/installed-agent/coding-agent")
        # No pipeline, no list and no second command: no `tee` or `grep` sibling holds the key.
        for operator in ("|", ";", "&", "\n", "`", "$("):
            self.assertNotIn(operator, command)
        # Harbor's exec_as_agent would add `set -o pipefail;`, which only a pipeline needs.
        self.assertNotIn("pipefail", command)

    def test_the_run_passes_no_credential_of_its_own(self) -> None:
        # Trial adds the --ae key to every exec of the agent phase, so run() passes no env and the
        # key appears nowhere in the command or the uploads.
        environment = FakeEnvironment()
        self.run_agent(environment)
        self.assertTrue(all(call.env is None for call in environment.execs))
        self.assertNotIn(PROVIDER_KEY, environment.agent_exec().command)
        self.assertNotIn(PROVIDER_KEY.encode(), environment.uploads[0][1])

    def test_a_model_identifier_keeps_its_further_slash(self) -> None:
        agent = self.create(
            model_name="openrouter/deepseek/deepseek-v4.1-flash-1017",
            key_variable="OPENROUTER_API_KEY",
        )
        environment = FakeEnvironment()
        self.run_agent(environment, agent=agent)
        tokens = shlex.split(environment.agent_exec().command)
        self.assertEqual(tokens[tokens.index("--provider") + 1], "openrouter")
        self.assertEqual(tokens[tokens.index("--model") + 1], "deepseek/deepseek-v4.1-flash-1017")

    def test_a_model_identifier_cannot_add_a_shell_command(self) -> None:
        agent = self.create(model_name="opencode/a b;$(id)|tee x")
        environment = FakeEnvironment()
        self.run_agent(environment, agent=agent)
        tokens = shlex.split(environment.agent_exec().command)
        self.assertEqual(tokens[tokens.index("--model") + 1], "a b;$(id)|tee x")
        self.assertEqual(tokens.count("exec"), 1)

    def test_the_output_dir_is_under_the_environment_logs_dir(self) -> None:
        agent = self.create(environment_logs_dir=PurePosixPath("/logs/agent-2"))
        environment = FakeEnvironment()
        self.run_agent(environment, agent=agent)
        tokens = shlex.split(environment.agent_exec().command)
        self.assertEqual(tokens[tokens.index("--output-dir") + 1], "/logs/agent-2/coding-agent")

    def test_a_settled_agent_session_returns_normally(self) -> None:
        # 0 succeeded, 1 failed, 130 cancelled (ADR 0005 §3): the verifier scores each one.
        for code in (0, 1, 130):
            with self.subTest(exit_code=code):
                context = AgentContext()
                self.run_agent(FakeEnvironment(return_code=code), context=context)
                # Harbor calls populate_context_post_run only for an empty context (CDA-90).
                self.assertTrue(context.is_empty())

    def test_any_other_exit_code_raises_the_non_zero_exit_error(self) -> None:
        for code in (2, 70, 126, 127, 137, 143, -9):
            with self.subTest(exit_code=code):
                environment = FakeEnvironment(return_code=code, stderr="usage: coding-agent run")
                with self.assertRaises(NonZeroAgentExitCodeError) as raised:
                    self.run_agent(environment)
                self.assertIs(type(raised.exception), NonZeroAgentExitCodeError)
                message = str(raised.exception)
                self.assertIn(f"Command failed (exit {code}): {ADR_COMMAND}", message)
                self.assertIn("stderr: usage: coding-agent run", message)

    def test_a_non_zero_exit_is_classified_as_exec_as_agent_would(self) -> None:
        environment = FakeEnvironment(return_code=2, stderr="error: Invalid API key")
        with self.assertRaises(AgentAuthenticationError):
            self.run_agent(environment)


if __name__ == "__main__":
    unittest.main()
