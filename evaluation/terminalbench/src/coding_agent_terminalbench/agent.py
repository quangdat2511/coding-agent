"""The Harbor installed agent for Coding Agent (ADR 0005 §6).

Harbor loads the class from its import path:

    harbor run -a coding_agent_terminalbench.agent:CodingAgent --ak artifact_dir=dist/artifact ...

The adapter depends on Coding Agent only through its command line (ADR 0005 §3) and the files it
writes (ADR 0005 §4). It imports nothing from the TypeScript packages, so ADR 0004's package graph
is unchanged.
"""

from collections.abc import Mapping
from pathlib import Path
from typing import Any, override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import Field, field_validator

from coding_agent_terminalbench.manifest import ArtifactManifest, load_manifest

AGENT_NAME = "coding-agent"


class CodingAgentOptions(InstalledAgentOptions):
    """The agent kwargs, passed to `harbor run` as `--ak <name>=<value>`."""

    artifact_dir: str = Field(
        description=(
            "Directory that `bun run build:artifact` wrote: both executables and "
            "artifact-manifest.json (ADR 0005 §2)."
        ),
    )
    version: str | None = Field(
        default=None,
        description="Not accepted. The version comes from artifact-manifest.json in artifact_dir.",
    )
    prompt_template_path: str | None = Field(
        default=None,
        description="Not accepted. The Coding Task objective is Harbor's instruction, verbatim.",
    )
    config: Any = Field(
        default=None,
        description="Not accepted. Coding Agent reads no native config file.",
    )

    # Harbor accepts a `version` kwarg for agents that install a chosen release. This agent runs
    # the build in `artifact_dir`, so a second source for the version could only disagree.
    @field_validator("version")
    @classmethod
    def _refuse_version(cls, value: str | None) -> None:
        if value is not None:
            raise ValueError(
                "the version comes from artifact-manifest.json in artifact_dir; remove this kwarg"
            )
        return None

    # ADR 0005 §5 runs Harbor's instruction verbatim, with no prompt template. Harbor renders a
    # template only through `with_prompt_template` on `run()`, so an accepted template would be
    # ignored without an error.
    @field_validator("prompt_template_path")
    @classmethod
    def _refuse_prompt_template(cls, value: str | None) -> None:
        if value is not None:
            raise ValueError(
                f"{AGENT_NAME} runs Harbor's instruction verbatim (ADR 0005 §5); remove this kwarg"
            )
        return None

    # BaseInstalledAgent refuses `config` in its constructor because the agent declares no
    # native config. Refusing it here as well makes preflight stop the job before any trial.
    @field_validator("config")
    @classmethod
    def _refuse_config(cls, value: Any) -> None:
        if value is not None:
            raise ValueError(f"{AGENT_NAME} reads no native config file; remove this kwarg")
        return None


def _artifact_dir(options: object) -> Path:
    """The `artifact_dir` kwarg of the options that `options_model` parsed."""
    if not isinstance(options, CodingAgentOptions):
        raise TypeError(f"{AGENT_NAME} expects CodingAgentOptions, found {type(options)}")
    return Path(options.artifact_dir)


class CodingAgent(BaseInstalledAgent):
    """Runs one Coding Agent artifact in a Harbor task container.

    The version that Harbor records comes from the artifact's manifest, so a trial result names the
    build that ran. CDA-88 makes `install()` confirm that the uploaded executable prints the same
    version.
    """

    capabilities = AgentCapabilities(atif=True)
    options_model = CodingAgentOptions

    def __init__(self, logs_dir: Path, *args: Any, **kwargs: Any) -> None:
        super().__init__(logs_dir, *args, **kwargs)
        self.artifact_dir = _artifact_dir(self.options)
        self.manifest: ArtifactManifest = load_manifest(self.artifact_dir)
        # Harbor's `version()` and `setup()` read `_version`, so this is the agent's one version.
        self._version = self.manifest.agent_version

    @classmethod
    @override
    def preflight(
        cls,
        kwargs: dict[str, Any] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        # Harbor runs this once before it queues trials, so a bad artifact directory stops the job
        # instead of failing every trial.
        load_manifest(_artifact_dir(cls.parse_options(kwargs, env)))

    @staticmethod
    @override
    def name() -> str:
        return AGENT_NAME

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # Harbor's setup() calls this, so the error fails setup and no trial runs an agent that was
        # never installed.
        raise NotImplementedError(
            "CDA-88 implements install(): select, check and upload the executable"
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        raise NotImplementedError("CDA-89 implements run(): execute the agent and map exit codes")
