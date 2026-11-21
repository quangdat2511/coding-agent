"""The fake model server of the credential isolation test, over real HTTP on localhost.

The server plays the Anthropic Messages API for one run. The artifact reaches it through
ANTHROPIC_BASE_URL and takes its Tool Calls from the scripted turns (ADR 0001 §8's test).
"""

import json
import unittest
import urllib.error
import urllib.request
from typing import Any

from coding_agent_terminalbench.isolation_server import FakeModelServer, TextTurn, ToolCallTurn

KEY = "sk-ant-isolation-test-0123456789abcdef0123456789abcdef"


def post(
    server: FakeModelServer, messages: list[dict[str, Any]] | None = None, key: str = KEY
) -> tuple[int, str, str]:
    """POST /v1/messages as the Anthropic SDK does. Returns the status, content type and body."""
    body = json.dumps({"model": "m", "stream": True, "messages": messages or []}).encode()
    request = urllib.request.Request(
        f"http://127.0.0.1:{server.port}/v1/messages",
        data=body,
        headers={"content-type": "application/json", "x-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, response.headers["content-type"], response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.headers["content-type"], error.read().decode()


def events(body: str) -> list[dict[str, Any]]:
    """The JSON payload of each `data:` line of a server-sent event stream."""
    return [
        json.loads(line[len("data: ") :]) for line in body.splitlines() if line.startswith("data: ")
    ]


def tool_result(tool_use_id: str, content: str | list[dict[str, str]]) -> dict[str, Any]:
    return {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": content}],
    }


class FakeModelServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = FakeModelServer(
            turns=[ToolCallTurn(command="echo hi"), TextTurn(text="all done")], expected_key=KEY
        )
        self.server.start()
        self.addCleanup(self.server.stop)

    def test_the_first_request_gets_a_bash_tool_call_as_a_server_sent_event_stream(self) -> None:
        status, content_type, body = post(self.server)

        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/event-stream")
        stream = events(body)
        started = [e for e in stream if e["type"] == "content_block_start"]
        self.assertEqual(started[0]["content_block"]["type"], "tool_use")
        self.assertEqual(started[0]["content_block"]["name"], "bash")
        arguments = "".join(
            e["delta"]["partial_json"] for e in stream if e["type"] == "content_block_delta"
        )
        self.assertEqual(json.loads(arguments), {"command": "echo hi"})
        stopped = [e for e in stream if e["type"] == "message_delta"]
        self.assertEqual(stopped[0]["delta"]["stop_reason"], "tool_use")

    def test_the_next_request_gets_the_next_turn(self) -> None:
        post(self.server)

        status, _, body = post(self.server, [tool_result("toolu_1", "hi")])

        self.assertEqual(status, 200)
        stream = events(body)
        text = "".join(e["delta"]["text"] for e in stream if e["type"] == "content_block_delta")
        self.assertEqual(text, "all done")
        self.assertEqual(
            [e for e in stream if e["type"] == "message_delta"][0]["delta"]["stop_reason"],
            "end_turn",
        )


class ObservationsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = FakeModelServer(
            turns=[ToolCallTurn(command="echo hi"), TextTurn(text="all done")], expected_key=KEY
        )
        self.server.start()
        self.addCleanup(self.server.stop)

    def test_it_counts_the_requests(self) -> None:
        self.assertEqual(self.server.request_count, 0)

        post(self.server)

        self.assertEqual(self.server.request_count, 1)

    def test_the_key_matches_only_when_every_request_carried_it(self) -> None:
        post(self.server)
        self.assertTrue(self.server.observations(expected_tool_results=1).key_matched)

        post(self.server, [tool_result("toolu_1", "hi")], key="a-different-key")

        self.assertFalse(self.server.observations(expected_tool_results=1).key_matched)

    def test_it_counts_the_tool_results_of_the_last_request_and_keeps_their_text(self) -> None:
        task = {"role": "user", "content": "task"}
        asked = {
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "toolu_1", "name": "bash", "input": {}}],
        }
        post(self.server, [task])

        post(self.server, [task, asked, tool_result("toolu_1", "line one\nline two")])

        self.assertEqual(self.server.tool_result_texts(), ["line one\nline two"])
        observed = self.server.observations(expected_tool_results=1)
        self.assertEqual(observed.tool_results_received, 1)
        self.assertEqual(observed.expected_tool_results, 1)

    def test_the_tool_results_of_earlier_turns_in_the_history_are_counted_too(self) -> None:
        # Coding Agent sends the whole history each time, so with two Tool Calls the last request
        # holds the first Tool Result in an earlier user message and the second in the last one.
        task = {"role": "user", "content": "task"}

        def asked(tool_use_id: str) -> dict[str, Any]:
            block = {"type": "tool_use", "id": tool_use_id, "name": "bash", "input": {}}
            return {"role": "assistant", "content": [block]}

        history = [
            task,
            asked("toolu_1"),
            tool_result("toolu_1", "first"),
            asked("toolu_2"),
            tool_result("toolu_2", "second"),
        ]
        post(self.server)

        post(self.server, history)

        self.assertEqual(self.server.tool_result_texts(), ["first", "second"])
        self.assertEqual(self.server.observations(expected_tool_results=2).tool_results_received, 2)

    def test_a_request_after_the_last_turn_gets_an_error_and_is_still_counted(self) -> None:
        post(self.server)
        post(self.server, [tool_result("toolu_1", "hi")])

        status, content_type, body = post(self.server, [tool_result("toolu_1", "hi")])

        self.assertEqual(status, 500)
        self.assertEqual(content_type, "application/json")
        self.assertIn("script", json.loads(body)["error"]["message"])
        self.assertEqual(self.server.request_count, 3)

    def test_a_tool_result_made_of_text_blocks_is_read_as_the_text_of_its_blocks(self) -> None:
        post(self.server)
        blocks = [{"type": "text", "text": "first "}, {"type": "text", "text": "second"}]

        post(self.server, [tool_result("toolu_1", blocks)])

        self.assertEqual(self.server.tool_result_texts(), ["first second"])


if __name__ == "__main__":
    unittest.main()
