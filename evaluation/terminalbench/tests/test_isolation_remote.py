"""The client side of a model server that runs in another sandbox (CDA-94).

The server there is the same FakeModelServer. Here it runs on localhost, so the client's reads go
over real HTTP and the test needs no Modal.
"""

import json
import unittest
import urllib.request
from typing import Any

from coding_agent_terminalbench.isolation_remote import RemoteModelServer
from coding_agent_terminalbench.isolation_server import FakeModelServer, TextTurn, ToolCallTurn

KEY = "sk-ant-isolation-test-0123456789abcdef0123456789abcdef"
SECRET = "run-secret-0123456789"


def post(base_url: str, messages: list[dict[str, Any]], key: str = KEY) -> None:
    request = urllib.request.Request(
        f"{base_url}/v1/messages",
        data=json.dumps({"stream": True, "messages": messages}).encode(),
        headers={"content-type": "application/json", "x-api-key": key},
        method="POST",
    )
    urllib.request.urlopen(request).read()


class RemoteModelServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.local = FakeModelServer(
            turns=[ToolCallTurn(command="echo hi"), TextTurn(text="done")],
            expected_key=KEY,
            observations_secret=SECRET,
        )
        self.local.start()
        self.addCleanup(self.local.stop)
        self.url = f"http://127.0.0.1:{self.local.port}"
        self.terminated = 0

        def terminate() -> None:
            self.terminated += 1

        self.remote = RemoteModelServer(launch=lambda: self.url, terminate=terminate, secret=SECRET)

    def test_it_reports_what_the_server_in_the_other_sandbox_saw(self) -> None:
        self.remote.start()
        answered = [
            {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "probe-out"}],
            }
        ]
        post(self.url, [{"role": "user", "content": "task"}])
        post(self.url, answered)

        observed = self.remote.observations(expected_tool_results=1)

        self.assertEqual(self.remote.request_count, 2)
        self.assertEqual(self.remote.tool_result_texts(), ["probe-out"])
        self.assertEqual(observed.tool_results_received, 1)
        self.assertEqual(observed.expected_tool_results, 1)
        self.assertTrue(observed.key_matched)

    def test_a_request_with_another_key_makes_key_matched_false(self) -> None:
        self.remote.start()
        post(self.url, [{"role": "user", "content": "task"}], key="sk-ant-someone-else")

        self.assertFalse(self.remote.observations(expected_tool_results=1).key_matched)

    def test_the_container_is_given_the_url_and_connects_to_its_host_and_port(self) -> None:
        self.remote.start()

        self.assertEqual(self.remote.base_url, self.url)
        self.assertEqual(self.remote.reach_target, ("127.0.0.1", self.local.port))

    def test_an_https_url_without_a_port_is_reached_on_443(self) -> None:
        remote = RemoteModelServer(
            launch=lambda: "https://abc123.w.modal.host", terminate=lambda: None, secret=SECRET
        )
        remote.start()

        self.assertEqual(remote.reach_target, ("abc123.w.modal.host", 443))

    def test_stop_terminates_the_other_sandbox(self) -> None:
        self.remote.start()
        self.remote.stop()

        self.assertEqual(self.terminated, 1)


if __name__ == "__main__":
    unittest.main()
