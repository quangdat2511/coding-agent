"""The credential isolation test (ADR 0001 §8, ADR 0005 §7 item 3), as a command.

    uv run --project evaluation/terminalbench --frozen python -m \\
        coding_agent_terminalbench.isolation_test \\
        --dataset <name>@<version> --task <task> --artifact-dir dist/artifact

It builds the task's container with Harbor, installs the artifact in it, and runs the test as the
user that Harbor runs the agent as. It prints one JSON result on standard output and a summary line
on standard error. Exit code 0 means the artifact passed, 1 means the artifact failed, and 2 means
the test showed nothing about a leak: it could not run, or every failure is one that shows nothing
about a leak (see INCONCLUSIVE).

The module imports Harbor only inside `run_in_backend`, so the rest of it is tested without Harbor.
"""

import argparse
import asyncio
import re
import secrets
import sys
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn, Protocol, TextIO

from coding_agent_terminalbench.install import ArtifactInstallError
from coding_agent_terminalbench.isolation_install import install_artifact
from coding_agent_terminalbench.isolation_report import (
    FailureCode,
    SecretInResultError,
    render_result,
)
from coding_agent_terminalbench.isolation_run import (
    IsolationRunError,
    IsolationSetup,
    ServerFactory,
    run_isolation_test,
)
from coding_agent_terminalbench.manifest import ArtifactManifestError

PROG = "isolation-test"

# The backends that a job can use (ADR 0005 §7): the smoke job may use Docker, the recorded job
# uses Modal.
BACKENDS = ("docker", "modal")

# A registry dataset with an explicit version (ADR 0008 §1). `latest`, an unversioned name and a
# local path are refused, because none of them fixes the task list.
DATASET = re.compile(r"^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*@(?!latest$)[\w.+-]+$")


class UsageError(ValueError):
    """The command line is wrong. The test does not start."""


@dataclass(frozen=True)
class Arguments:
    dataset: str
    task: str
    backend: str
    artifact_dir: Path
    model: str
    output: Path | None
    container_host: str
    server_host: str


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise UsageError(message)


def parse_arguments(argv: Sequence[str]) -> Arguments:
    parser = _Parser(prog=PROG, add_help=False)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--backend", default="docker", choices=BACKENDS)
    parser.add_argument("--artifact-dir", required=True, type=Path)
    parser.add_argument("--model", default=IsolationSetup.model)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--container-host", default="host.docker.internal")
    parser.add_argument("--server-host", default=IsolationSetup.server_host)
    parsed = parser.parse_args(list(argv))
    if DATASET.fullmatch(parsed.dataset) is None:
        raise UsageError(
            f"--dataset {parsed.dataset!r} is not <org>/<name>@<version>; a version is required, "
            "and `latest`, an unversioned name and a local path are refused (ADR 0008 §1)"
        )
    return Arguments(
        dataset=parsed.dataset,
        task=parsed.task,
        backend=parsed.backend,
        artifact_dir=parsed.artifact_dir,
        model=parsed.model,
        output=parsed.output,
        container_host=parsed.container_host,
        server_host=parsed.server_host,
    )


def new_disposable_key() -> str:
    """A key that is clearly not real, new for every run, and long enough to be found by value."""
    return f"sk-ant-isolation-test-{secrets.token_hex(16)}"


# The failures that show nothing about a leak. MEM_NOT_DEMONSTRABLE, CONTROL_FAILED and
# PATH_NOT_TESTED come from the host or image: Yama hides the mem read, or a probe or control could
# not show anything. TOOL_RESULTS_MISSING and KEY_NOT_DELIVERED mean that the test could not drive
# the agent, which can come from the artifact, for example one that ignores ANTHROPIC_BASE_URL.
# A run whose every failure is one of these exits 2, like a run that could not start, because
# exit 1 means that a Tool Call found the key or the launcher was not refused.
INCONCLUSIVE = frozenset(
    {
        FailureCode.MEM_NOT_DEMONSTRABLE,
        FailureCode.CONTROL_FAILED,
        FailureCode.PATH_NOT_TESTED,
        FailureCode.TOOL_RESULTS_MISSING,
        FailureCode.KEY_NOT_DELIVERED,
    }
)


def inconclusive(document: dict[str, Any]) -> bool:
    codes = {failure["code"] for failure in document["failures"]}
    return not document["passed"] and codes <= INCONCLUSIVE


def exit_code(document: dict[str, Any]) -> int:
    if document["passed"]:
        return 0
    return 2 if inconclusive(document) else 1


def summary_line(document: dict[str, Any]) -> str:
    if document["passed"]:
        return (
            f"PASS: no Tool Call found the key on {len(document['probes'])} paths, and the "
            "launcher that keeps its shell was refused; the agent ran as uid "
            f"{document['user']['uid']}"
        )
    codes = ", ".join(failure["code"] for failure in document["failures"])
    return f"INCONCLUSIVE: {codes}" if inconclusive(document) else f"FAIL: {codes}"


Runner = Callable[[Arguments, str], Awaitable[dict[str, Any]]]


class Startable(Protocol):
    async def start(self, force_build: bool) -> None: ...

    async def stop(self, delete: bool) -> None: ...


@asynccontextmanager
async def started(
    environment: Startable, name: str, log: Callable[[str], None]
) -> AsyncIterator[None]:
    """Starts the environment, and always stops and deletes it afterwards.

    The stop runs even when the start fails, because Docker can have made a container and a
    network before a healthcheck times out. A stop that fails is logged and does not hide why the
    run ended.
    """
    try:
        try:
            await environment.start(force_build=False)
        except Exception as error:  # Docker is not running, or the image does not build
            raise IsolationRunError(f"cannot start the container of {name}: {error}") from error
        yield
    finally:
        try:
            await environment.stop(delete=True)
        except Exception as error:
            log(f"cannot stop and delete the container of {name}: {error}")


async def run_in_docker(arguments: Arguments, key: str) -> dict[str, Any]:
    return await run_in_backend("docker", arguments, key)


async def run_in_backend(
    backend: str, arguments: Arguments, key: str, serve: ServerFactory | None = None
) -> dict[str, Any]:
    """Builds the task's container with Harbor on `backend` and runs the test in it.

    `serve` makes the model server. The default is a server on this host, which only Docker's
    containers can reach."""
    from harbor.environments.factory import EnvironmentFactory
    from harbor.models.environment_type import EnvironmentType
    from harbor.models.task.id import PackageTaskId
    from harbor.models.task.task import Task
    from harbor.models.trial.paths import TrialPaths
    from harbor.registry.client.package import PackageDatasetClient
    from harbor.tasks.client import TaskClient

    try:
        metadata = await PackageDatasetClient().get_dataset_metadata(arguments.dataset)
    except Exception as error:  # the network, the registry service, or an unknown version
        raise IsolationRunError(
            f"Harbor's registry cannot resolve {arguments.dataset}: {error}"
        ) from error
    tasks = [t for t in metadata.task_ids if isinstance(t, PackageTaskId)]
    chosen = [t for t in tasks if arguments.task in (t.name, t.get_name())]
    if not chosen:
        names = ", ".join(sorted(t.name for t in tasks))
        raise IsolationRunError(
            f"{arguments.dataset} has no task {arguments.task!r}; it has: {names}"
        )
    downloaded = await TaskClient().download_tasks([chosen[0]])
    task = Task(downloaded.paths[0])

    def log(line: str) -> None:
        print(f"{PROG}: {line}", file=sys.stderr)

    setup = IsolationSetup(
        dataset=arguments.dataset,
        task=task.name,
        backend=backend,
        key=key,
        container_host=arguments.container_host,
        model=arguments.model,
        server_host=arguments.server_host,
    )
    with tempfile.TemporaryDirectory(prefix="isolation-trial-") as trial_dir:
        trial_paths = TrialPaths(trial_dir=Path(trial_dir))
        trial_paths.mkdir()
        environment = EnvironmentFactory.create_environment(
            type=EnvironmentType[backend.upper()],
            environment_dir=task.paths.environment_dir,
            environment_name=task.name,
            session_id=f"isolation-{secrets.token_hex(4)}__env",
            trial_paths=trial_paths,
            task_env_config=task.config.environment,
        )
        async with started(environment, task.name, log):
            # The user that Harbor runs the agent as, taken from the task, not chosen here.
            with environment.with_default_user(task.config.agent.user):
                try:
                    await install_artifact(environment, arguments.artifact_dir)
                except (ArtifactInstallError, ArtifactManifestError) as error:
                    raise IsolationRunError(f"cannot install the artifact: {error}") from error
                return await run_isolation_test(environment, setup, log=log, serve=serve)


def default_runners() -> Mapping[str, Runner]:
    # Imported here, so that a test of the command line needs neither Harbor nor Modal.
    from coding_agent_terminalbench.isolation_modal import run_in_modal

    return {"docker": run_in_docker, "modal": run_in_modal}


def main(
    argv: Sequence[str],
    run: Runner | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    runners: Mapping[str, Runner] | None = None,
) -> int:
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr
    try:
        arguments = parse_arguments(argv)
    except UsageError as error:
        print(f"{PROG}: {error}", file=err)
        return 2
    key = new_disposable_key()
    try:
        runner = run or (runners or default_runners())[arguments.backend]
        document = asyncio.run(runner(arguments, key))
        text = render_result(document, secret=key)
    except (IsolationRunError, SecretInResultError) as error:
        print(f"{PROG}: {str(error).replace(key, '[redacted]')}", file=err)
        return 2
    except Exception as error:
        # Exit 1 means the artifact failed. Any other error, such as a task download that broke
        # or a container that answered in a way the test did not expect, says nothing about the
        # artifact, so the test reports that it could not run.
        message = f"{type(error).__name__}: {error}".replace(key, "[redacted]")
        print(f"{PROG}: the test could not run: {message}", file=err)
        return 2
    # The file comes first, so a run that cannot record its result prints none either: exit 2
    # with a result on stdout would read as a record of the run.
    if arguments.output is not None:
        try:
            arguments.output.write_text(text)
        except OSError as error:
            print(f"{PROG}: cannot write {arguments.output}: {error}", file=err)
            return 2
    out.write(text)
    print(summary_line(document), file=err)
    return exit_code(document)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
