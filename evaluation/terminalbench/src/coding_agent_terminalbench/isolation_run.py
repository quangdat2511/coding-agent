"""Runs the credential isolation test in one task container (ADR 0001 §8, ADR 0005 §7).

The artifact must already be installed at `/installed-agent/coding-agent`, as the adapter's
`install()` leaves it. The run has four steps:

1. Read who runs the agent and which build it is.
2. Run the launcher that keeps its shell alive. The startup check must refuse it.
3. Run the launcher that does `exec`, with a fake model server on the host that has a Tool Call run
   the probe. This is the run that the artifact is judged on.
4. Run the same probe against a process that holds the key and is not hardened, as the control.

The container is anything with `exec` and `upload_file`, which is Harbor's `BaseEnvironment`. This
module imports nothing from Harbor, so its tests need no Docker.
"""

import asyncio
import re
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from coding_agent_terminalbench.install import INSTALLED_EXECUTABLE
from coding_agent_terminalbench.isolation_probe import build_probe_script, parse_probe_output
from coding_agent_terminalbench.isolation_report import (
    Control,
    LauncherResult,
    Probe,
    RunContext,
    ServerObservations,
    result_document,
)
from coding_agent_terminalbench.isolation_server import FakeModelServer, TextTurn, ToolCallTurn
from coding_agent_terminalbench.launch import (
    INSTRUCTION_PATH,
    PROVIDER_KEY_VARIABLES,
    ModelChoice,
    build_command,
)

KEY_VARIABLE = PROVIDER_KEY_VARIABLES["anthropic"][0]
BASE_URL_VARIABLE = "ANTHROPIC_BASE_URL"

PROBE_PATH = "/tmp/isolation-probe.sh"
LOGS_DIR = PurePosixPath("/tmp/isolation-logs")

# ADR 0001 §8's refusal names the ancestor and the variable. Exit 2 alone is not enough, because
# every configuration error exits with 2.
REFUSAL = re.compile(rf"ancestor process \d+ \(sh\) holds {KEY_VARIABLE}")

AGENT_TIMEOUT_SECONDS = 300


class IsolationRunError(RuntimeError):
    """The test could not run, which is not the same as the artifact failing it."""


class Container(Protocol):
    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> Any: ...

    async def upload_file(self, source_path: Path | str, target_path: str) -> None: ...


@dataclass(frozen=True)
class IsolationSetup:
    """What the run needs besides the container."""

    dataset: str
    task: str
    backend: str
    # The disposable key. The caller generates it, so this module never reads the environment.
    key: str
    # The host name that the container uses to reach the server on the host.
    container_host: str
    # The `--model` of the agent: any model that the artifact's anthropic catalog holds.
    model: str = "claude-haiku-4-5"
    # The address that the server binds on the host.
    server_host: str = "127.0.0.1"


async def run_isolation_test(
    container: Container,
    setup: IsolationSetup,
    log: Callable[[str], None] = lambda _: None,
) -> dict[str, Any]:
    """The result document of the test. It raises IsolationRunError when it cannot run."""
    context, yama_ptrace_scope = await _read_identity(container, setup)
    await _prepare(container, setup)
    launcher = await _run_launcher_that_keeps_its_shell(container, setup, log)
    probes, server = await _run_agent(container, setup, log)
    controls = await _run_control(container, setup)
    return result_document(context, probes, controls, yama_ptrace_scope, launcher, server)


async def _read_identity(container: Container, setup: IsolationSetup) -> tuple[RunContext, int | None]:
    version = await container.exec(f"{INSTALLED_EXECUTABLE} --version")
    parts = (version.stdout or "").split()
    if version.return_code != 0 or len(parts) != 3 or parts[0] != "coding-agent":
        raise IsolationRunError(
            f"{INSTALLED_EXECUTABLE} --version did not print `coding-agent <version> <commit>`"
        )
    digest = await container.exec(f"sha256sum {INSTALLED_EXECUTABLE}", user="root")
    uid = await container.exec("id -u")
    name = await container.exec("id -un")
    yama = await container.exec("cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null")
    context = RunContext(
        coding_agent_version=parts[1],
        coding_agent_commit=parts[2],
        executable_sha256=((digest.stdout or "").split() or [""])[0],
        dataset=setup.dataset,
        task=setup.task,
        backend=setup.backend,
        uid=int((uid.stdout or "").strip()),
        user_name=(name.stdout or "").strip(),
    )
    scope = (yama.stdout or "").strip() if yama.return_code == 0 else ""
    return context, int(scope) if scope.isdigit() else None


async def _prepare(container: Container, setup: IsolationSetup) -> None:
    """Uploads the probe and the Coding Task, and makes a place for the agent's files.

    `upload_file` copies as root, so root also makes each file readable by the agent user.
    """
    with tempfile.TemporaryDirectory(prefix="isolation-") as directory:
        probe = Path(directory) / "probe.sh"
        probe.write_text(build_probe_script(setup.key, INSTALLED_EXECUTABLE))
        instruction = Path(directory) / "instruction.md"
        instruction.write_text("Run the command that the task names.\n")
        await container.upload_file(probe, PROBE_PATH)
        await container.upload_file(instruction, INSTRUCTION_PATH)
    await container.exec(
        f"chmod 0644 {PROBE_PATH} {INSTRUCTION_PATH} && mkdir -p {LOGS_DIR} && chmod 0777 {LOGS_DIR}",
        user="root",
    )


def _agent_environment(setup: IsolationSetup, server: FakeModelServer) -> dict[str, str]:
    """The environment of the launcher: the disposable key, and the server as the base URL. The key
    is the only credential, as in a job (ADR 0005 §6)."""
    return {
        KEY_VARIABLE: setup.key,
        BASE_URL_VARIABLE: f"http://{setup.container_host}:{server.port}",
    }


def _agent_command(setup: IsolationSetup) -> str:
    return build_command(ModelChoice(provider="anthropic", model=setup.model), LOGS_DIR)


async def _run_launcher_that_keeps_its_shell(
    container: Container, setup: IsolationSetup, log: Callable[[str], None]
) -> LauncherResult:
    # The same command as the job's, without its `exec`: the shell stays alive and holds the key.
    command = "sh -c '\"$@\"; exit $?' sh " + _agent_command(setup).removeprefix("exec ")
    server = FakeModelServer(turns=[], expected_key=setup.key, host=setup.server_host)
    server.start()
    try:
        result = await container.exec(
            command,
            env=_agent_environment(setup, server),
            timeout_sec=AGENT_TIMEOUT_SECONDS,
        )
    finally:
        server.stop()
    first_line = next((line for line in (result.stderr or "").splitlines() if line.strip()), "")
    return LauncherResult(
        exit_code=result.return_code,
        message_matched=REFUSAL.search(first_line) is not None,
        server_requests=server.request_count,
    )


async def _run_agent(
    container: Container, setup: IsolationSetup, log: Callable[[str], None]
) -> tuple[list[Probe], ServerObservations]:
    turns = [ToolCallTurn(command=f"sh {PROBE_PATH}"), TextTurn(text="Done.")]
    server = FakeModelServer(turns=turns, expected_key=setup.key, host=setup.server_host)
    server.start()
    try:
        result = await container.exec(
            _agent_command(setup),
            env=_agent_environment(setup, server),
            timeout_sec=AGENT_TIMEOUT_SECONDS,
        )
    finally:
        server.stop()
    if result.return_code != 0:
        tail = (result.stderr or "").replace(setup.key, "[redacted]").strip()[-400:]
        log(f"the agent exited {result.return_code}: {tail}")
    probes = parse_probe_output("\n".join(server.tool_result_texts()))
    return probes, server.observations(expected_tool_results=1)


async def _run_control(container: Container, setup: IsolationSetup) -> list[Control]:
    # A shell that holds the key in its environment and carries the agent's marker in its command
    # line stands in for an agent that is not hardened, and the probe runs as its child.
    command = f"sh -c 'sh {PROBE_PATH}; : {INSTALLED_EXECUTABLE}'"
    result = await container.exec(command, env={KEY_VARIABLE: setup.key})
    return [Control(path=p.path, found=p.found) for p in parse_probe_output(result.stdout or "")]
