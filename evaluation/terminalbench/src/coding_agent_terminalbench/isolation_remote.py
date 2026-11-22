"""A model server that runs in another sandbox, for backends whose containers cannot reach the host.

Modal runs the task container in the cloud, so a server on the host is out of reach (CDA-94). The
test runs the same FakeModelServer in a second sandbox that has a public port. This client starts
it, tells the task container where it is, and reads what it saw through the secret path of
`isolation_server`. The launch and the termination are functions that the Modal runner passes in,
so this module imports neither Modal nor Harbor.
"""

import json
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

from coding_agent_terminalbench.isolation_report import ServerObservations

READ_TIMEOUT_SECONDS = 30


class RemoteModelServer:
    def __init__(self, launch: Callable[[], str], terminate: Callable[[], None], secret: str) -> None:
        self._launch = launch
        self._terminate = terminate
        self._secret = secret
        self._url = ""

    def start(self) -> None:
        self._url = self._launch()

    def stop(self) -> None:
        self._terminate()

    @property
    def base_url(self) -> str:
        return self._url

    @property
    def reach_target(self) -> tuple[str, int]:
        parsed = urlparse(self._url)
        default = 443 if parsed.scheme == "https" else 80
        return parsed.hostname or "", parsed.port or default

    def _read(self) -> dict[str, Any]:
        url = f"{self._url}/observations/{self._secret}"
        with urllib.request.urlopen(url, timeout=READ_TIMEOUT_SECONDS) as response:
            return json.loads(response.read())

    @property
    def request_count(self) -> int:
        return int(self._read()["requestCount"])

    def tool_result_texts(self) -> list[str]:
        return [str(text) for text in self._read()["toolResultTexts"]]

    def observations(self, expected_tool_results: int) -> ServerObservations:
        seen = self._read()
        return ServerObservations(
            tool_results_received=len(seen["toolResultTexts"]),
            expected_tool_results=expected_tool_results,
            key_matched=all(seen["keysMatched"]),
        )
