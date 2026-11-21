"""Runs the credential isolation test on Modal (ADR 0005 §7 item 3, CDA-94).

A Modal task container runs in the cloud, so it cannot reach a server on this host. The model
server therefore runs in a second Modal sandbox that has a public port, and the host reads what it
saw through the secret path of `isolation_server`. The server holds only the disposable key.

The imports of Modal and of the test's command module are inside functions, so a test of the
command line needs neither Modal nor Harbor.
"""

import secrets
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from coding_agent_terminalbench.isolation_remote import RemoteModelServer
from coding_agent_terminalbench.isolation_run import ModelServer, ServerFactory
from coding_agent_terminalbench.isolation_server import Turn, turns_to_json

APP_NAME = "coding-agent-isolation-test"
PORT = 8000
SOURCE = Path(__file__).resolve().parent
# The server imports only the report module. Modal's slim Python image has Python 3.12.
SERVER_FILES = ("__init__.py", "isolation_server.py", "isolation_report.py")
REMOTE_DIRECTORY = "/srv/coding_agent_terminalbench"
READY_TIMEOUT_SECONDS = 90
SANDBOX_TIMEOUT_SECONDS = 1800


def modal_servers(key: str) -> ServerFactory:
    """Servers that each run in their own Modal sandbox, for a task container on Modal."""

    def make(turns: list[Turn]) -> ModelServer:
        secret = secrets.token_hex(16)
        sandboxes: list[Any] = []

        def launch() -> str:
            import modal

            app = modal.App.lookup(APP_NAME, create_if_missing=True)
            sandbox = modal.Sandbox.create(
                "sleep",
                "infinity",
                app=app,
                image=modal.Image.debian_slim(python_version="3.12"),
                encrypted_ports=[PORT],
                timeout=SANDBOX_TIMEOUT_SECONDS,
            )
            sandboxes.append(sandbox)
            for name in SERVER_FILES:
                sandbox.filesystem.copy_from_local(SOURCE / name, f"{REMOTE_DIRECTORY}/{name}")
            sandbox.exec(
                "python",
                "-m",
                "coding_agent_terminalbench.isolation_server",
                "--expected-key",
                key,
                "--observations-secret",
                secret,
                "--turns",
                turns_to_json(turns),
                "--port",
                str(PORT),
                workdir="/srv",
            )
            url = sandbox.tunnels()[PORT].url
            _wait_until_ready(f"{url}/observations/{secret}")
            return url

        def terminate() -> None:
            for sandbox in sandboxes:
                sandbox.terminate()

        return RemoteModelServer(launch=launch, terminate=terminate, secret=secret)

    return make


def _wait_until_ready(url: str) -> None:
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    while True:
        try:
            with urllib.request.urlopen(url, timeout=10):
                return
        except (urllib.error.URLError, OSError) as error:
            if time.monotonic() > deadline:
                raise RuntimeError(f"the model server in the second sandbox is not up: {error}")
            time.sleep(2)


async def run_in_modal(arguments: Any, key: str) -> dict[str, Any]:
    from coding_agent_terminalbench.isolation_test import run_in_backend

    return await run_in_backend("modal", arguments, key, serve=modal_servers(key))
