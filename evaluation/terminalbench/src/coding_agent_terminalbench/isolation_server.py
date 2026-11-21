"""A fake Anthropic Messages server for the credential isolation test (ADR 0001 §8, ADR 0005 §7).

The artifact under test is a compiled executable with no test hook, so the test cannot give it a
model. The `anthropic` provider sets no base URL, so the SDK reads ANTHROPIC_BASE_URL, and the test
points the artifact at this server. Each request gets the next scripted turn: a `bash` Tool Call,
then a text answer. The server runs on the host, outside the task container, so no process in the
container holds the disposable key that arrives in the `x-api-key` header.

It imports nothing from Harbor.
"""

import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from coding_agent_terminalbench.isolation_report import ServerObservations


@dataclass(frozen=True)
class ToolCallTurn:
    """The model asks for one `bash` Tool Call that runs `command`."""

    command: str


@dataclass(frozen=True)
class TextTurn:
    """The model answers in text and ends its turn."""

    text: str


Turn = ToolCallTurn | TextTurn

MODEL = "claude-isolation-test"


def _event(name: str, data: dict[str, Any]) -> str:
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def _stream(turn: Turn, number: int) -> str:
    """The server-sent events of the Messages API for one turn."""
    start = _event(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": f"msg_{number}",
                "type": "message",
                "role": "assistant",
                "model": MODEL,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        },
    )
    if isinstance(turn, ToolCallTurn):
        block = {"type": "tool_use", "id": f"toolu_{number}", "name": "bash", "input": {}}
        delta = {"type": "input_json_delta", "partial_json": json.dumps({"command": turn.command})}
        reason = "tool_use"
    else:
        block = {"type": "text", "text": ""}
        delta = {"type": "text_delta", "text": turn.text}
        reason = "end_turn"
    return (
        start
        + _event(
            "content_block_start",
            {"type": "content_block_start", "index": 0, "content_block": block},
        )
        + _event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta})
        + _event("content_block_stop", {"type": "content_block_stop", "index": 0})
        + _event(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": reason, "stop_sequence": None},
                "usage": {"output_tokens": 1},
            },
        )
        + _event("message_stop", {"type": "message_stop"})
    )


def _tool_result_texts(request: dict[str, Any]) -> list[str]:
    """The text of each `tool_result` block in the user messages of a Messages request, in order.

    Coding Agent sends the whole history with each request, so the last request holds the Tool
    Result of every turn, each in its own user message.
    """
    texts: list[str] = []
    for message in request.get("messages") or []:
        if message.get("role") != "user" or not isinstance(message.get("content"), list):
            continue
        for block in message["content"]:
            if block.get("type") != "tool_result":
                continue
            content = block.get("content", "")
            if isinstance(content, list):
                content = "".join(part.get("text", "") for part in content)
            texts.append(content)
    return texts


class FakeModelServer:
    """Plays the model provider for one run. It answers `POST /v1/messages` and nothing else."""

    def __init__(
        self, turns: list[Turn], expected_key: str, host: str = "127.0.0.1", port: int = 0
    ) -> None:
        self._turns = turns
        self._expected_key = expected_key
        self._lock = threading.Lock()
        self._requests = 0
        self._keys_matched: list[bool] = []
        self._last_tool_results: list[str] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - the name http.server calls
                length = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(length) or b"{}")
                with server._lock:
                    number = server._requests
                    server._requests += 1
                    server._keys_matched.append(self.headers.get("x-api-key") == server._expected_key)
                    server._last_tool_results = _tool_result_texts(request)
                if number >= len(server._turns):
                    # Coding Agent asked for more than the script holds. Answer with an error, not a
                    # stream, so the run ends in a failure that names the cause.
                    message = (
                        f"the script has {len(server._turns)} turns and this is request {number + 1}"
                    )
                    failure = json.dumps(
                        {"type": "error", "error": {"type": "api_error", "message": message}}
                    ).encode()
                    self.send_response(500)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(failure)))
                    self.end_headers()
                    self.wfile.write(failure)
                    return
                turn = server._turns[number]
                body = _stream(turn, number + 1).encode()
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self._httpd = ThreadingHTTPServer((host, port), Handler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def port(self) -> int:
        return int(self._httpd.server_address[1])

    @property
    def request_count(self) -> int:
        with self._lock:
            return self._requests

    def tool_result_texts(self) -> list[str]:
        """The Tool Results in the last request, which holds the whole history."""
        with self._lock:
            return list(self._last_tool_results)

    def observations(self, expected_tool_results: int) -> ServerObservations:
        with self._lock:
            return ServerObservations(
                tool_results_received=len(self._last_tool_results),
                expected_tool_results=expected_tool_results,
                key_matched=all(self._keys_matched),
            )

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join()
