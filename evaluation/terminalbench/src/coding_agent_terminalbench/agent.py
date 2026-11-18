"""The Harbor installed agent for Coding Agent (ADR 0005 §6).

Harbor loads the class from its import path:

    harbor run -a coding_agent_terminalbench.agent:CodingAgent --ak artifact_dir=dist/artifact ...

The adapter depends on Coding Agent only through its command line (ADR 0005 §3) and the files it
writes (ADR 0005 §4). It imports nothing from the TypeScript packages, so ADR 0004's package graph
is unchanged.
"""

import asyncio
from collections.abc import Mapping
from pathlib import Path
from typing import Any, override

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.options import InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from pydantic import Field, field_validator

from coding_agent_terminalbench.install import (
    BASH_HINT,
    GLIBC_HINT,
    INSTALLED_EXECUTABLE,
    ArtifactInstallError,
    check_executable,
    check_uploaded_sha256,
    check_version_output,
    select_executable,
)
from coding_agent_terminalbench.manifest import (
    ArtifactExecutable,
    ArtifactManifest,
    load_manifest,
)
from coding_agent_terminalbench.trajectory import AgentIdentity
from coding_agent_terminalbench.trial_context import TRAJECTORY_FILE, populate_trial_context

AGENT_NAME = "coding-agent"

# ADR 0005 §6 runs `coding-agent run --output-dir <environment_logs_dir>/coding-agent`, so the
# three files of a run arrive in this directory of the logs that Harbor downloads.
RUN_DIR_NAME = "coding-agent"


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
    build that ran. `install()` confirms that the uploaded executable prints the same version.
    """

    capabilities = AgentCapabilities(atif=True)
    options_model = CodingAgentOptions

    def __init__(self, logs_dir: Path, *args: Any, **kwargs: Any) -> None:
        super().__init__(logs_dir, *args, **kwargs)
        self.artifact_dir = _artifact_dir(self.options)
        self.manifest: ArtifactManifest = load_manifest(self.artifact_dir)
        # Harbor's `version()` and `setup()` read `_version`, so this is the agent's one version.
        self._version = self.manifest.agent_version
        # The executable that install() uploaded and checked. The trial metadata names its file,
        # because the version line of the x64 and arm64 builds is the same.
        self.installed_executable: ArtifactExecutable | None = None

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
        """Installs the artifact's executable in the task container (ADR 0005 §6).

        Harbor's `setup()` calls this. Every check raises `ArtifactInstallError`, so a container
        that cannot run this exact build fails setup and never starts a trial.
        """
        # 1. The container's architecture selects the executable.
        uname = await environment.exec(command="uname -m")
        machine = (uname.stdout or "").strip()
        if uname.return_code != 0:
            raise ArtifactInstallError(
                f"cannot read the task container's architecture: `uname -m` exited "
                f"{uname.return_code} with stderr {(uname.stderr or '').strip()!r}"
                + (BASH_HINT if uname.return_code in (126, 127) else "")
            )
        if machine == "":
            raise ArtifactInstallError(
                "cannot read the task container's architecture: `uname -m` printed nothing"
            )
        executable = select_executable(self.manifest, machine)

        # 2. The host copy must be the file that the build hashed. Hashing about 94 MB takes a
        # moment, so it runs in a thread and concurrent trials keep running.
        source = await asyncio.to_thread(check_executable, self.artifact_dir, executable)
        await environment.upload_file(source, INSTALLED_EXECUTABLE)
        await self._check_uploaded_bytes(environment, executable)
        # upload_file copies as root. Mode 0755 lets every user run the file, the agent user
        # included, and only root can change it.
        await self.exec_as_root(environment, command=f"chmod 0755 {INSTALLED_EXECUTABLE}")

        # 3. ADR 0001's `bash` tool needs bash. Most images have it, so one check is the common
        # case. Harbor's helper only logs a warning when the image has no package manager it
        # knows, so a second check after the helper fails setup instead. On Docker and Modal an
        # image without bash already failed at `uname -m`, because Harbor runs commands through
        # bash; this step covers environments that do not.
        if not await self._has_bash(environment):
            await self.ensure_system_dependencies(environment, ("bash",))
            if not await self._has_bash(environment):
                raise ArtifactInstallError(
                    "the task container has no bash, and Harbor found no package manager to "
                    "install it; the agent's bash tool needs it"
                )

        # 4. The uploaded file must print the manifest's version. It runs as the agent user, so
        # this also proves that this user can run it.
        printed = await environment.exec(command=f"{INSTALLED_EXECUTABLE} --version")
        if printed.return_code != 0:
            raise ArtifactInstallError(
                f"{INSTALLED_EXECUTABLE} --version exited {printed.return_code} with stderr "
                f"{(printed.stderr or '').strip()!r}"
                + (GLIBC_HINT if printed.return_code == 127 else "")
            )
        check_version_output(self.manifest, printed.stdout)

        # The output equals the manifest's version line, so `_version`, which the constructor read
        # from the manifest, is now the version of the build that this trial runs.
        self.installed_executable = executable

    async def _check_uploaded_bytes(
        self, environment: BaseEnvironment, executable: ArtifactExecutable
    ) -> None:
        """Hashes the uploaded file in the container, when the image has `sha256sum`.

        coreutils and BusyBox both provide it. An image without it keeps the host check only, and
        the job log says so: installing a tool for this would break "nothing else is installed"
        (ADR 0005 §6).
        """
        digest = await environment.exec(command=f"sha256sum {INSTALLED_EXECUTABLE}", user="root")
        if digest.return_code == 127:
            self.logger.warning(
                "the task container has no sha256sum, so install() checked the SHA-256 of the "
                "executable on the host only"
            )
            return
        if digest.return_code != 0:
            raise ArtifactInstallError(
                f"sha256sum {INSTALLED_EXECUTABLE} exited {digest.return_code} with stderr "
                f"{(digest.stderr or '').strip()!r}"
            )
        check_uploaded_sha256(executable, digest.stdout)

    async def _has_bash(self, environment: BaseEnvironment) -> bool:
        found = await environment.exec(command="command -v bash >/dev/null 2>&1", user="root")
        return found.return_code == 0

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        raise NotImplementedError("CDA-89 implements run(): execute the agent and map exit codes")

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        """Fills the trial context and writes the ATIF trajectory (ADR 0005 §6).

        Harbor calls this once it has downloaded the agent's logs, and only while the context is
        empty. It runs after the trial, so a log that cannot be read must not turn a finished trial
        into a harness exception: the problem is reported in the job log, and the context keeps
        whatever could be filled in.
        """
        try:
            populate_trial_context(
                context,
                self.logs_dir / RUN_DIR_NAME,
                trajectory_path=self.logs_dir / TRAJECTORY_FILE,
                agent=AgentIdentity(name=AGENT_NAME, version=self.version()),
                artifact_sha256={
                    executable.file: executable.sha256 for executable in self.manifest.executables
                },
                installed_executable=(
                    self.installed_executable.file if self.installed_executable else None
                ),
            )
        except Exception as error:
            self.logger.warning(
                f"the trial context and trajectory are incomplete: {error}", exc_info=True
            )
