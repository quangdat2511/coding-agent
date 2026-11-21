"""The credential isolation test (ADR 0001 §8, ADR 0005 §7 item 3), as a command.

    uv run --project evaluation/terminalbench --frozen python -m \\
        coding_agent_terminalbench.isolation_test \\
        --dataset <name>@<version> --task <task> --artifact-dir dist/artifact

It builds the task's container with Harbor, installs the artifact in it, and runs the test as the
user that Harbor runs the agent as. It prints one JSON result on standard output and a summary line
on standard error. Exit code 0 means the artifact passed, 1 means the run finished and the artifact
failed, and 2 means the test could not run.

The module imports Harbor only inside `run_in_docker`, so the rest of it is tested without Harbor.
"""

import argparse
import asyncio
import re
import secrets
import sys
import tempfile
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, NoReturn, TextIO

from coding_agent_terminalbench.install import ArtifactInstallError
from coding_agent_terminalbench.isolation_install import install_artifact
from coding_agent_terminalbench.isolation_report import SecretInResultError, render_result
from coding_agent_terminalbench.isolation_run import (
    IsolationRunError,
    IsolationSetup,
    run_isolation_test,
)
from coding_agent_terminalbench.manifest import ArtifactManifestError

PROG = "isolation-test"

# A registry dataset with an explicit version (ADR 0008 §1). `latest`, an unversioned name and a
# local path are refused, because none of them fixes the task list.
DATASET = re.compile(r"^[A-Za-z0-9][\w.-]*/[A-Za-z0-9][\w.-]*@(?!latest$)[\w.+-]+$")


class UsageError(ValueError):
    """The command line is wrong. The test does not start."""


@dataclass(frozen=True)
class Arguments:
    dataset: str
    task: str
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
        artifact_dir=parsed.artifact_dir,
        model=parsed.model,
        output=parsed.output,
        container_host=parsed.container_host,
        server_host=parsed.server_host,
    )


def new_disposable_key() -> str:
    """A key that is clearly not real, new for every run, and long enough to be found by value."""
    return f"sk-ant-isolation-test-{secrets.token_hex(16)}"


def summary(document: dict[str, Any]) -> str:
    if document["passed"]:
        return (
            f"PASS: no Tool Call found the key on {len(document['probes'])} paths, and the "
            "launcher that keeps its shell was refused; the agent ran as uid "
            f"{document['user']['uid']}"
        )
    return "FAIL: " + ", ".join(failure["code"] for failure in document["failures"])


Runner = Callable[[Arguments, str], Awaitable[dict[str, Any]]]


async def run_in_docker(arguments: Arguments, key: str) -> dict[str, Any]:
    """Builds the task's container with Harbor and runs the test in it."""
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

    setup = IsolationSetup(
        dataset=arguments.dataset,
        task=task.name,
        backend="docker",
        key=key,
        container_host=arguments.container_host,
        model=arguments.model,
        server_host=arguments.server_host,
    )
    with tempfile.TemporaryDirectory(prefix="isolation-trial-") as trial_dir:
        trial_paths = TrialPaths(trial_dir=Path(trial_dir))
        trial_paths.mkdir()
        environment = EnvironmentFactory.create_environment(
            type=EnvironmentType.DOCKER,
            environment_dir=task.paths.environment_dir,
            environment_name=task.name,
            session_id=f"isolation-{secrets.token_hex(4)}__env",
            trial_paths=trial_paths,
            task_env_config=task.config.environment,
        )
        try:
            await environment.start(force_build=False)
        except Exception as error:  # Docker is not running, or the image does not build
            raise IsolationRunError(
                f"cannot start the container of {task.name}: {error}"
            ) from error
        try:
            # The user that Harbor runs the agent as, taken from the task, not chosen here.
            with environment.with_default_user(task.config.agent.user):
                try:
                    await install_artifact(environment, arguments.artifact_dir)
                except (ArtifactInstallError, ArtifactManifestError) as error:
                    raise IsolationRunError(f"cannot install the artifact: {error}") from error
                return await run_isolation_test(
                    environment, setup, log=lambda line: print(f"{PROG}: {line}", file=sys.stderr)
                )
        finally:
            await environment.stop(delete=True)


def main(
    argv: Sequence[str],
    run: Runner = run_in_docker,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
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
        document = asyncio.run(run(arguments, key))
        text = render_result(document, secret=key)
    except (IsolationRunError, SecretInResultError) as error:
        print(f"{PROG}: {error}", file=err)
        return 2
    out.write(text)
    if arguments.output is not None:
        arguments.output.write_text(text)
    print(summary(document), file=err)
    return 0 if document["passed"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
