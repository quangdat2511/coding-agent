"""Fixtures for the artifact manifest and for the files that Coding Agent writes.

`artifact-manifest.json` comes from `scripts/build-artifact.ts`. `run.json`, `events.jsonl` and
`result.json` come from `packages/coding-agent/src/run-files.ts`, and the events they carry from
`packages/agent-core/src/events.ts` (ADR 0005 §4). Every fixture here is written by hand: a change
to one of those writers changes the fixture in the same pull request.
"""

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

COMMIT = "64128afd1c0f27db530cf167b015d206ef67c707"
IMPORT_PATH = "coding_agent_terminalbench.agent:CodingAgent"

# A made-up key. The tests put it in a patched os.environ, as if the host had exported it.
PROVIDER_KEY = "test-provider-key"

RUN_ID = "run-1"

OCCURRED_AT = "2026-11-12T00:00:00.000Z"

OBJECTIVE = "The parser drops the last argument of every call."

SYSTEM_PROMPT = "You are Coding Agent.\n"

MODEL = {"id": "gemini-3.5-flash-lite", "name": "Gemini 3.5 Flash Lite", "provider": "google"}

MODEL_TURN_1 = "model_turn-1"
MODEL_TURN_2 = "model_turn-2"
MESSAGE_1 = "assistant_message-1"
MESSAGE_2 = "assistant_message-2"
CALL_1 = "tool_call-1"
CALL_2 = "tool_call-2"
PROVIDER_CALL_A = "provider_call_a"
PROVIDER_CALL_B = "provider_call_b"

FINAL_TEXT = "The last argument now reaches the parser."

FEEDBACK = "The parser test still fails: expected 3 arguments, found 2."

# The normalized finish reason and the raw one that `packages/ai` keeps beside it.
FINISH_REASONS = {
    "end_turn": "STOP",
    "tool_call": "STOP",
    "error": "MODEL_FAILURE",
}


def dataset_record_markdown(rows: Mapping[str, str]) -> str:
    """A committed dataset record in the two-column table shape of ADR 0008 §4.

    ADR 0008 §1 records each dataset's data in a Markdown file with the rows of §4's table, so the
    tests write one by hand. The tests build their own row values; this writes the table.
    """
    lines = ["# Example dataset record", "", "| Item | Value |", "| --- | --- |"]
    lines.extend(f"| {label} | {value} |" for label, value in rows.items())
    return "\n".join(lines) + "\n"


def manifest_data(**overrides: Any) -> dict[str, Any]:
    """A manifest with the shape that scripts/build-artifact.ts writes.

    The fixture is written by hand. test_built_manifest.py compares its shape with the manifest
    that the build wrote in CI, so a change to the build's schema fails there.
    """
    data: dict[str, Any] = {
        "schemaVersion": 1,
        "codingAgent": {"version": "0.0.1", "commit": COMMIT},
        "dirty": False,
        "bunVersion": "1.3.14",
        "executables": [
            {
                "file": "coding-agent-linux-x64",
                "target": "bun-linux-x64-baseline",
                "sha256": "a" * 64,
            },
            {
                "file": "coding-agent-linux-arm64",
                "target": "bun-linux-arm64",
                "sha256": "b" * 64,
            },
        ],
    }
    data.update(overrides)
    return data


def write_artifact(artifact_dir: Path) -> dict[str, Any]:
    """Writes both executables and a manifest whose SHA-256 values match them.

    The executables are short byte strings, not programs: the tests never run them. Returns the
    manifest data.
    """
    data = manifest_data()
    artifact_dir.mkdir(parents=True, exist_ok=True)
    for executable in data["executables"]:
        content = f"fake {executable['target']} executable\n".encode()
        (artifact_dir / executable["file"]).write_bytes(content)
        executable["sha256"] = hashlib.sha256(content).hexdigest()
    write_manifest(artifact_dir, data)
    return data


def write_manifest(artifact_dir: Path, data: Any) -> None:
    artifact_dir.mkdir(parents=True, exist_ok=True)
    (artifact_dir / "artifact-manifest.json").write_text(
        f"{json.dumps(data, indent=2)}\n", encoding="utf-8"
    )


# The files of a run (ADR 0005 §4)


def run_record_data(**overrides: Any) -> dict[str, Any]:
    """The `RunRecord` that `packages/coding-agent/src/run-files.ts` writes to run.json."""
    data: dict[str, Any] = {
        "schemaVersion": 1,
        "codingAgent": {"version": "0.0.1", "commit": COMMIT},
        "provider": "google",
        "model": MODEL["id"],
        "sampling": {"maxOutputTokens": None, "temperature": None},
        "transportRetryBound": 2,
        "repoRoot": "/app",
        "profile": "terminalbench",
        "limits": {
            "maxModelTurns": 250,
            "maxToolCalls": 1_000,
            "maxDurationMs": 3_600_000,
            "maxConsecutiveRecoverableFailures": 10,
            "cancellationGraceMs": 5_000,
        },
        "approvalPolicy": "auto-approve",
        "verification": {"command": None},
        "tools": ["read", "write", "edit", "bash"],
        "systemPrompt": SYSTEM_PROMPT,
    }
    data.update(overrides)
    return data


def agent_result(*, drop: tuple[str, ...] = (), **overrides: Any) -> dict[str, Any]:
    """The `AgentResult` of a settled Agent Run, as `run_settled` and result.json carry it."""
    data: dict[str, Any] = {
        "outcome": "succeeded",
        "finalMessage": assistant_message([text_block(FINAL_TEXT)]),
        "usage": {"inputTokens": 2_700, "outputTokens": 80, "cachedInputTokens": 1_000},
        "verification": {
            "outcome": "succeeded",
            "evidence": [{"type": "no_command_configured", "workspaceChanged": True}],
        },
        "workspaceChanged": True,
        "partialChangesPossible": False,
        "lastSequence": 16,
    }
    for key in drop:
        data.pop(key, None)
    data.update(overrides)
    return data


def result_record_data(result: dict[str, Any], *, exit_code: int = 0) -> dict[str, Any]:
    """The `ResultRecord` that `run-files.ts` writes to result.json."""
    return {
        "schemaVersion": 1,
        "exitCode": exit_code,
        "result": result,
        "finishedAt": "2026-11-12T00:00:16.000Z",
    }


def event(sequence: int, type: str, data: dict[str, Any]) -> dict[str, Any]:
    """One line of events.jsonl, in the envelope of ADR 0002 that `run-files.ts` writes."""
    return {
        "schemaVersion": 1,
        "runId": RUN_ID,
        "sequence": sequence,
        "occurredAt": OCCURRED_AT,
        "type": type,
        "data": data,
    }


def events(*entries: tuple[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """A log of the given events, numbered from 1 as the writer numbers them."""
    return [event(index + 1, type, data) for index, (type, data) in enumerate(entries)]


def text_block(text: str) -> dict[str, str]:
    return {"type": "text", "text": text}


def tool_call_block(provider_call_id: str, name: str, arguments: str) -> dict[str, str]:
    return {
        "type": "tool_call",
        "toolCallId": provider_call_id,
        "name": name,
        "arguments": arguments,
    }


def assistant_message(
    content: list[dict[str, Any]], *, finish: str = "end_turn"
) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": content,
        "model": MODEL["id"],
        "finishReason": {"reason": finish, "rawReason": FINISH_REASONS[finish]},
    }


def run_started() -> tuple[str, dict[str, Any]]:
    return ("run_started", {"task": {"objective": OBJECTIVE}})


def model_turn_started(model_turn_id: str, index: int) -> tuple[str, dict[str, Any]]:
    """A Model Turn begins: `model_turn_started` then `assistant_message_started`."""
    return ("model_turn_started", {"modelTurnId": model_turn_id, "index": index, "model": MODEL})


def assistant_message_started(
    model_turn_id: str, message_id: str
) -> tuple[str, dict[str, Any]]:
    return ("assistant_message_started", {"modelTurnId": model_turn_id, "messageId": message_id})


def assistant_message_completed(
    message_id: str,
    message: dict[str, Any],
    *,
    outcome: str = "completed",
    failure: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    data: dict[str, Any] = {"messageId": message_id, "outcome": outcome, "message": message}
    if failure is not None:
        data["failure"] = failure
    return ("assistant_message_completed", data)


def tool_call_queued(
    model_turn_id: str, queue_index: int, core_id: str, provider_id: str, name: str, arguments: str
) -> tuple[str, dict[str, Any]]:
    return (
        "tool_call_queued",
        {
            "modelTurnId": model_turn_id,
            "queueIndex": queue_index,
            "toolCall": {
                "id": core_id,
                "providerId": provider_id,
                "name": name,
                "arguments": arguments,
            },
        },
    )


def tool_execution_started(
    core_id: str, *, mutation: str = "read_only"
) -> tuple[str, dict[str, Any]]:
    return ("tool_execution_started", {"toolCallId": core_id, "mutation": mutation})


def tool_result(
    core_id: str, name: str, content: str, *, is_error: bool = False
) -> dict[str, Any]:
    return {
        "toolCallId": core_id,
        "toolName": name,
        "content": content,
        "isError": is_error,
        "metadata": {"durationMs": 3},
    }


def tool_call_completed(
    core_id: str, outcome: str, *, result: dict[str, Any] | None = None, reason: str | None = None
) -> tuple[str, dict[str, Any]]:
    data: dict[str, Any] = {"toolCallId": core_id, "outcome": outcome}
    if result is not None:
        data["result"] = result
    if reason is not None:
        data["reason"] = reason
    return ("tool_call_completed", data)


def model_turn_completed(
    model_turn_id: str,
    usage: dict[str, int],
    *,
    outcome: str = "completed",
    failure: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    data: dict[str, Any] = {"modelTurnId": model_turn_id, "outcome": outcome, "usage": usage}
    if failure is not None:
        data["failure"] = failure
    return ("model_turn_completed", data)


def candidate_completion_detected(
    model_turn_id: str, message_id: str
) -> tuple[str, dict[str, Any]]:
    return (
        "candidate_completion_detected",
        {"modelTurnId": model_turn_id, "messageId": message_id},
    )


def verification_started(
    index: int, model_turn_id: str, message_id: str
) -> tuple[str, dict[str, Any]]:
    return (
        "verification_started",
        {
            "verificationId": f"verification-{index}",
            "candidate": {"modelTurnId": model_turn_id, "messageId": message_id},
        },
    )


def verification_completed(
    index: int, outcome: str, *, feedback: Any = None
) -> tuple[str, dict[str, Any]]:
    data: dict[str, Any] = {
        "verificationId": f"verification-{index}",
        "outcome": outcome,
        "evidence": [{"type": "no_command_configured", "workspaceChanged": True}],
    }
    if feedback is not None:
        data["feedback"] = feedback
    return ("verification_completed", data)


def run_settled(result: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    return ("run_settled", {"result": result})


def complete_events() -> list[dict[str, Any]]:
    """A settled Agent Run: two Model Turns, one read Tool Call, and Verification succeeding."""
    return events(
        run_started(),
        model_turn_started(MODEL_TURN_1, 0),
        assistant_message_started(MODEL_TURN_1, MESSAGE_1),
        assistant_message_completed(
            MESSAGE_1,
            assistant_message(
                [
                    text_block("Reading the parser."),
                    tool_call_block(PROVIDER_CALL_A, "read", '{"path": "src/parser.py"}'),
                ],
                finish="tool_call",
            ),
        ),
        tool_call_queued(
            MODEL_TURN_1, 0, CALL_1, PROVIDER_CALL_A, "read", '{"path": "src/parser.py"}'
        ),
        tool_execution_started(CALL_1),
        tool_call_completed(
            CALL_1, "succeeded", result=tool_result(CALL_1, "read", "def parse(arguments):\n")
        ),
        model_turn_completed(
            MODEL_TURN_1,
            {"inputTokens": 1_200, "outputTokens": 48, "cachedInputTokens": 1_000},
        ),
        model_turn_started(MODEL_TURN_2, 1),
        assistant_message_started(MODEL_TURN_2, MESSAGE_2),
        assistant_message_completed(MESSAGE_2, assistant_message([text_block(FINAL_TEXT)])),
        candidate_completion_detected(MODEL_TURN_2, MESSAGE_2),
        model_turn_completed(MODEL_TURN_2, {"inputTokens": 1_500, "outputTokens": 32}),
        verification_started(1, MODEL_TURN_2, MESSAGE_2),
        verification_completed(1, "succeeded"),
        run_settled(agent_result()),
    )


def truncated_events() -> list[dict[str, Any]]:
    """The complete Agent Run, killed while its second Model Turn runs a write Tool Call.

    The writer appends each event as it arrives (ADR 0005 §4), so a killed process loses the tail:
    no Tool Result, no `model_turn_completed` for that turn, and no `run_settled`.
    """
    return events(
        run_started(),
        model_turn_started(MODEL_TURN_1, 0),
        assistant_message_started(MODEL_TURN_1, MESSAGE_1),
        assistant_message_completed(
            MESSAGE_1,
            assistant_message(
                [
                    text_block("Reading the parser."),
                    tool_call_block(PROVIDER_CALL_A, "read", '{"path": "src/parser.py"}'),
                ],
                finish="tool_call",
            ),
        ),
        tool_call_queued(
            MODEL_TURN_1, 0, CALL_1, PROVIDER_CALL_A, "read", '{"path": "src/parser.py"}'
        ),
        tool_execution_started(CALL_1),
        tool_call_completed(
            CALL_1, "succeeded", result=tool_result(CALL_1, "read", "def parse(arguments):\n")
        ),
        model_turn_completed(
            MODEL_TURN_1,
            {"inputTokens": 1_200, "outputTokens": 48, "cachedInputTokens": 1_000},
        ),
        model_turn_started(MODEL_TURN_2, 1),
        assistant_message_started(MODEL_TURN_2, MESSAGE_2),
        assistant_message_completed(
            MESSAGE_2,
            assistant_message(
                [
                    text_block("Writing the fix."),
                    tool_call_block(
                        PROVIDER_CALL_B,
                        "write",
                        '{"path": "src/parser.py", "content": "def parse(arguments):\\n"}',
                    ),
                ],
                finish="tool_call",
            ),
        ),
        tool_call_queued(
            MODEL_TURN_2,
            0,
            CALL_2,
            PROVIDER_CALL_B,
            "write",
            '{"path": "src/parser.py", "content": "def parse(arguments):\\n"}',
        ),
        # A mutating Tool Call asks for an Approval even under auto-approve, and the policy answers.
        (
            "approval_requested",
            {"approvalId": "approval-1", "toolCallId": CALL_2, "policy": "auto-approve"},
        ),
        (
            "approval_resolved",
            {
                "approvalId": "approval-1",
                "toolCallId": CALL_2,
                "status": "auto_approved",
                "decidedBy": "policy",
            },
        ),
        tool_execution_started(CALL_2, mutation="mutating"),
    )


def feedback_events() -> list[dict[str, Any]]:
    """An Agent Run that Verification sends back once, with feedback, before it succeeds."""
    return events(
        run_started(),
        model_turn_started(MODEL_TURN_1, 0),
        assistant_message_started(MODEL_TURN_1, MESSAGE_1),
        assistant_message_completed(MESSAGE_1, assistant_message([text_block("Fixed it.")])),
        candidate_completion_detected(MODEL_TURN_1, MESSAGE_1),
        model_turn_completed(
            MODEL_TURN_1,
            {"inputTokens": 1_200, "outputTokens": 48, "cachedInputTokens": 1_000},
        ),
        verification_started(1, MODEL_TURN_1, MESSAGE_1),
        verification_completed(
            1, "continue", feedback={"role": "user", "content": [text_block(FEEDBACK)]}
        ),
        model_turn_started(MODEL_TURN_2, 1),
        assistant_message_started(MODEL_TURN_2, MESSAGE_2),
        assistant_message_completed(MESSAGE_2, assistant_message([text_block(FINAL_TEXT)])),
        candidate_completion_detected(MODEL_TURN_2, MESSAGE_2),
        model_turn_completed(MODEL_TURN_2, {"inputTokens": 1_500, "outputTokens": 32}),
        verification_started(2, MODEL_TURN_2, MESSAGE_2),
        verification_completed(2, "succeeded"),
        run_settled(agent_result()),
    )


def cancelled_events() -> list[dict[str, Any]]:
    """An Agent Run cancelled while a Tool Call runs: the call ends with no Tool Result."""
    result = agent_result(
        drop=("verification",),
        outcome="cancelled",
        cancellation={"reason": "SIGINT"},
        usage={"inputTokens": 1_200, "outputTokens": 48, "cachedInputTokens": 1_000},
        finalMessage=None,
        lastSequence=10,
    )
    return events(
        run_started(),
        model_turn_started(MODEL_TURN_1, 0),
        assistant_message_started(MODEL_TURN_1, MESSAGE_1),
        assistant_message_completed(
            MESSAGE_1,
            assistant_message(
                [
                    text_block("Running the tests."),
                    tool_call_block(PROVIDER_CALL_A, "bash", '{"command": "pytest -q"}'),
                ],
                finish="tool_call",
            ),
        ),
        tool_call_queued(
            MODEL_TURN_1, 0, CALL_1, PROVIDER_CALL_A, "bash", '{"command": "pytest -q"}'
        ),
        tool_execution_started(CALL_1),
        # `closeModelTurn` records the outcome of a call whose Tool Result never arrived.
        (
            "cancellation_requested",
            {"reason": "SIGINT", "requestedFrom": "executing_tool"},
        ),
        tool_call_completed(CALL_1, "cancelled"),
        model_turn_completed(
            MODEL_TURN_1,
            {"inputTokens": 1_200, "outputTokens": 48, "cachedInputTokens": 1_000},
            outcome="cancelled",
        ),
        run_settled(result),
    )


def failed_events() -> list[dict[str, Any]]:
    """An Agent Run whose first Model Turn fails: the Assistant Message records the failure."""
    failure = {"code": "MODEL_FAILURE", "message": "the provider returned 503"}
    result = agent_result(
        drop=("verification",),
        outcome="failed",
        failure=failure,
        usage={"inputTokens": 0, "outputTokens": 0},
        finalMessage=None,
        lastSequence=6,
    )
    return events(
        run_started(),
        model_turn_started(MODEL_TURN_1, 0),
        assistant_message_started(MODEL_TURN_1, MESSAGE_1),
        assistant_message_completed(
            MESSAGE_1,
            assistant_message([text_block("Writing the fi")], finish="error"),
            outcome="failed",
            failure=failure,
        ),
        model_turn_completed(
            MODEL_TURN_1,
            {"inputTokens": 0, "outputTokens": 0},
            outcome="failed",
            failure=failure,
        ),
        run_settled(result),
    )


# A file that a caller does not name keeps the fixture of a complete run; `None` leaves it out.
DEFAULT = object()


def write_run_files(
    directory: Path,
    *,
    record: Any = DEFAULT,
    log: Any = DEFAULT,
    result: Any = DEFAULT,
) -> None:
    """Writes the files of a run into `directory`.

    A complete run is the default, so a test names only the file it changes. `None` leaves a file
    out, as a run killed before it settled leaves result.json out.
    """
    directory.mkdir(parents=True, exist_ok=True)
    # `ensure_ascii=False` mirrors `JSON.stringify`, which leaves non-ASCII characters raw.
    if record is not None:
        if record is DEFAULT:
            record = run_record_data()
        (directory / "run.json").write_text(
            f"{json.dumps(record, indent=2, ensure_ascii=False)}\n", encoding="utf-8"
        )
    if log is not None:
        if log is DEFAULT:
            log = complete_events()
        lines = "".join(f"{json.dumps(item, ensure_ascii=False)}\n" for item in log)
        (directory / "events.jsonl").write_text(lines, encoding="utf-8")
    if result is not None:
        if result is DEFAULT:
            result = result_record_data(agent_result())
        (directory / "result.json").write_text(
            f"{json.dumps(result, indent=2, ensure_ascii=False)}\n", encoding="utf-8"
        )


# A stand-in for Harbor's ExecResult, for the tests that script a task container without importing
# Harbor. It has the three fields that the code under test reads.


@dataclass
class ExecOutcome:
    stdout: str | None = ""
    stderr: str | None = ""
    return_code: int = 0
