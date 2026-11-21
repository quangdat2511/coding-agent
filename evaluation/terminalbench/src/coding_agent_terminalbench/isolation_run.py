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
import shlex
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
    Observations,
    Probe,
    RunContext,
    ServerObservations,
    result_document,
)
from coding_agent_terminalbench.isolation_server import (
    FakeModelServer,
    TextTurn,
    ToolCallTurn,
    Turn,
)
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
REACH_TIMEOUT_SECONDS = 30


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


class ModelServer(Protocol):
    """What the run needs of a model server, wherever it runs: on this host, or in another
    sandbox that the container reaches over the internet (CDA-94)."""

    @property
    def base_url(self) -> str: ...

    @property
    def reach_target(self) -> tuple[str, int]: ...

    @property
    def request_count(self) -> int: ...

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def tool_result_texts(self) -> list[str]: ...

    def observations(self, expected_tool_results: int) -> ServerObservations: ...


# Starts nothing: it makes a server that plays `turns`, and the run starts and stops it.
ServerFactory = Callable[[list[Turn]], ModelServer]


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


def local_servers(setup: IsolationSetup) -> ServerFactory:
    """Servers on this host, which the container reaches as `setup.container_host`."""
    return lambda turns: FakeModelServer(
        turns=turns,
        expected_key=setup.key,
        host=setup.server_host,
        container_host=setup.container_host,
    )


async def run_isolation_test(
    container: Container,
    setup: IsolationSetup,
    log: Callable[[str], None] = lambda _: None,
    serve: ServerFactory | None = None,
) -> dict[str, Any]:
    """The result document of the test. It raises IsolationRunError when it cannot run.

    `serve` makes the model server. The default runs it on this host (Docker); Modal cannot reach
    the host, so its runner passes a server that runs in another sandbox."""
    serve = serve or local_servers(setup)
    context, yama_ptrace_scope = await _read_identity(container, setup)
    await _prepare(container, setup)
    launcher = await _run_launcher_that_keeps_its_shell(container, setup, log, serve)
    probes, server = await _run_agent(container, setup, log, serve)
    controls = await _run_control(container, setup)
    observed = Observations(probes, controls, yama_ptrace_scope, launcher, server)
    return result_document(context, observed)


async def _read_identity(
    container: Container, setup: IsolationSetup
) -> tuple[RunContext, int | None]:
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
        f"chmod 0644 {PROBE_PATH} {INSTRUCTION_PATH} "
        f"&& mkdir -p {LOGS_DIR} && chmod 0777 {LOGS_DIR}",
        user="root",
    )


def _agent_environment(setup: IsolationSetup, server: ModelServer) -> dict[str, str]:
    """The environment of the launcher: the disposable key, and the server as the base URL. The key
    is the only credential, as in a job (ADR 0005 §6)."""
    return {
        KEY_VARIABLE: setup.key,
        BASE_URL_VARIABLE: server.base_url,
    }


def _agent_command(setup: IsolationSetup) -> str:
    return build_command(ModelChoice(provider="anthropic", model=setup.model), LOGS_DIR)


async def _run_launcher_that_keeps_its_shell(
    container: Container,
    setup: IsolationSetup,
    log: Callable[[str], None],
    serve: ServerFactory,
) -> LauncherResult:
    # The same command as the job's, without its `exec`: the shell stays alive and holds the key.
    command = "sh -c '\"$@\"; exit $?' sh " + _agent_command(setup).removeprefix("exec ")
    server = serve([])
    try:
        await asyncio.to_thread(server.start)
        result = await container.exec(
            command,
            env=_agent_environment(setup, server),
            timeout_sec=AGENT_TIMEOUT_SECONDS,
        )
        # Read before `stop`: a server in another sandbox is gone once it is stopped.
        server_requests = await asyncio.to_thread(lambda: server.request_count)
    finally:
        await asyncio.to_thread(server.stop)
    # Harbor's Docker environment sends standard error into standard output, so the refusal can
    # arrive in either stream. The agent prints nothing before it refuses.
    output = f"{result.stderr or ''}\n{result.stdout or ''}"
    first_line = next((line for line in output.splitlines() if line.strip()), "")
    matched = REFUSAL.search(first_line) is not None
    if not matched:
        log(
            f"the launcher that keeps its shell ended with exit {result.return_code} and "
            f"printed: {first_line.replace(setup.key, '[redacted]')[:400]}"
        )
    return LauncherResult(
        exit_code=result.return_code,
        message_matched=matched,
        server_requests=server_requests,
    )


async def _check_server_reachable(container: Container, server: ModelServer) -> None:
    """Fails with IsolationRunError unless the container can open a connection to the server.

    Without this, a container that cannot reach the host would look like an artifact that ignores
    ANTHROPIC_BASE_URL: the server gets no Tool Result either way. The connection sends no request,
    so the server does not count it. It uses bash, which install_artifact already requires.
    """
    host, port = server.reach_target
    target = f"/dev/tcp/{host}/{port}"
    try:
        reach = await container.exec(
            "bash -c " + shlex.quote(f"exec 3<>{target}"), timeout_sec=REACH_TIMEOUT_SECONDS
        )
        reached = reach.return_code == 0
    except RuntimeError:  # Harbor raises RuntimeError when timeout_sec runs out
        reached = False
    if not reached:
        raise IsolationRunError(
            f"the task container cannot reach the fake model server at {host}:{port}; "
            "on a Linux host with Docker, set --container-host and --server-host"
        )


async def _run_agent(
    container: Container,
    setup: IsolationSetup,
    log: Callable[[str], None],
    serve: ServerFactory,
) -> tuple[list[Probe], ServerObservations]:
    turns: list[Turn] = [ToolCallTurn(command=f"sh {PROBE_PATH}"), TextTurn(text="Done.")]
    server = serve(turns)
    try:
        await asyncio.to_thread(server.start)
        await _check_server_reachable(container, server)
        result = await container.exec(
            _agent_command(setup),
            env=_agent_environment(setup, server),
            timeout_sec=AGENT_TIMEOUT_SECONDS,
        )
        # Read before `stop`: a server in another sandbox is gone once it is stopped.
        texts = await asyncio.to_thread(server.tool_result_texts)
        observed = await asyncio.to_thread(server.observations, expected_tool_results=1)
    finally:
        await asyncio.to_thread(server.stop)
    if result.return_code != 0:
        output = f"{result.stderr or ''}{result.stdout or ''}"
        tail = output.replace(setup.key, "[redacted]").strip()[-400:]
        log(f"the agent exited {result.return_code}: {tail}")
    return parse_probe_output("\n".join(texts)), observed


async def _run_control(container: Container, setup: IsolationSetup) -> list[Control]:
    # A shell that holds the key in its environment and carries the agent's marker in its command
    # line stands in for an agent that is not hardened, and the probe runs as its child.
    command = f"sh -c 'sh {PROBE_PATH}; : {INSTALLED_EXECUTABLE}'"
    result = await container.exec(command, env={KEY_VARIABLE: setup.key})
    return [Control(path=p.path, found=p.found) for p in parse_probe_output(result.stdout or "")]
