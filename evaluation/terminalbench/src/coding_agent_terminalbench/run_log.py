"""Reads the files a run writes: run.json, events.jsonl and result.json (ADR 0005 §4).

The three files are the external contract of `coding-agent run`, so this module follows
`packages/coding-agent/src/run-files.ts` and the envelopes of
`packages/agent-core/src/events.ts`. A change there changes this module in the same pull request.
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RUN_FILE = "run.json"

EVENTS_FILE = "events.jsonl"

RESULT_FILE = "result.json"

# ADR 0005 §4: all three files carry this schema version.
SCHEMA_VERSION = 1

# The Session Events that the adapter reads, from packages/agent-core/src/events.ts.
TASK_EVENT = "session_started"
TURN_STARTED_EVENT = "model_turn_started"
TURN_COMPLETED_EVENT = "model_turn_completed"
MESSAGE_COMPLETED_EVENT = "assistant_message_completed"
CALL_QUEUED_EVENT = "tool_call_queued"
CALL_COMPLETED_EVENT = "tool_call_completed"
FEEDBACK_EVENT = "verification_completed"
LIMIT_REACHED_EVENT = "runtime_limit_reached"
SETTLED_EVENT = "session_settled"


class RunLogError(ValueError):
    """The run directory has no run.json, or a file does not have the shape ADR 0005 §4 fixes."""


@dataclass(frozen=True)
class RunRecord:
    """The part of run.json that the adapter reads (ADR 0005 §4)."""

    system_prompt: str
    provider: str | None
    model: str | None
    profile: str | None
    tool_names: tuple[str, ...]


@dataclass(frozen=True)
class SessionEvent:
    """One line of events.jsonl, in the envelope of ADR 0002."""

    session_id: str
    sequence: int
    occurred_at: str
    type: str
    data: Mapping[str, Any]


@dataclass(frozen=True)
class TokenCounts:
    """Token counts, each one absent when nothing recorded it."""

    input: int | None = None
    output: int | None = None
    cached: int | None = None

    def plus(self, other: "TokenCounts") -> "TokenCounts":
        return TokenCounts(
            input=_added(self.input, other.input),
            output=_added(self.output, other.output),
            cached=_added(self.cached, other.cached),
        )


def tokens_of(usage: Any) -> TokenCounts:
    """The counts of a `UsageTotals` object, as run.json, result.json and the events write it."""
    if not isinstance(usage, Mapping):
        return TokenCounts()
    return TokenCounts(
        input=_count(usage.get("inputTokens")),
        output=_count(usage.get("outputTokens")),
        cached=_count(usage.get("cachedInputTokens")),
    )


@dataclass(frozen=True)
class RunLog:
    """The files of one run, as the adapter reads them."""

    record: RunRecord
    events: tuple[SessionEvent, ...]
    # The Agent Result from result.json, or from the settled event when that file is missing.
    agent_result: Mapping[str, Any] | None

    @property
    def session_id(self) -> str | None:
        return self.events[0].session_id if self.events else None

    @property
    def truncated(self) -> bool:
        """Whether the log stops before the session settled (ADR 0005 §4).

        The writer is an ordinary consumer that the producer never awaits, so a killed process
        loses the tail. A log that does not end with `session_settled` is truncated.
        """
        return not self.events or self.events[-1].type != SETTLED_EVENT

    @property
    def usage(self) -> TokenCounts:
        """The token counts of the run, as Harbor defines them (cached tokens included).

        The Agent Result is the authority when there is one. result.json is written after
        `session_settled`, so a truncated log has no Agent Result and the usage of each completed
        Model Turn is summed instead.
        """
        if self.agent_result is not None:
            return tokens_of(self.agent_result.get("usage"))
        tokens = TokenCounts()
        for event in self.events:
            if event.type == TURN_COMPLETED_EVENT:
                tokens = tokens.plus(tokens_of(event.data.get("usage")))
        return tokens


def load_run_log(directory: Path) -> RunLog:
    """Reads the three files that `coding-agent run --output-dir` wrote into `directory`."""
    record = _read_record(directory / RUN_FILE)
    events = _read_events(directory / EVENTS_FILE)
    agent_result = _read_result(directory / RESULT_FILE)
    if agent_result is None:
        agent_result = _settled_result(events)
    return RunLog(record=record, events=events, agent_result=agent_result)


def _read_record(path: Path) -> RunRecord:
    data = _read_document(
        path,
        missing=(
            f"{path} does not exist; the adapter reads the directory that "
            "`coding-agent run --output-dir` wrote"
        ),
    )
    if not isinstance(data, Mapping):
        raise RunLogError(f"{path}: the run record must be a JSON object")
    _require_schema_version(data, path)
    system_prompt = data.get("systemPrompt")
    if not isinstance(system_prompt, str):
        raise RunLogError(f"{path}: systemPrompt must be a string")
    tools = data.get("tools")
    return RunRecord(
        system_prompt=system_prompt,
        provider=_optional_text(data, "provider"),
        model=_optional_text(data, "model"),
        profile=_optional_text(data, "profile"),
        tool_names=(
            tuple(name for name in tools if isinstance(name, str))
            if isinstance(tools, list)
            else ()
        ),
    )


def _read_events(path: Path) -> tuple[SessionEvent, ...]:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ()
    except OSError as exc:
        raise RunLogError(f"cannot read {path}: {exc}") from exc

    events: list[SessionEvent] = []
    for number, line in enumerate(text.splitlines(), start=1):
        if line.strip() == "":
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            # The writer appends one line per event, so a line that does not decode is an event
            # the process never finished appending, and nothing after it can be trusted.
            return tuple(events)
        if not isinstance(data, Mapping):
            return tuple(events)
        _require_schema_version(data, path, line=number)
        event = _event_of(data)
        if event is None:
            return tuple(events)
        events.append(event)
    return tuple(events)


def _read_result(path: Path) -> Mapping[str, Any] | None:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        # A run settles before it writes result.json, so the file is missing when it was killed.
        return None
    except OSError as exc:
        raise RunLogError(f"cannot read {path}: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RunLogError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, Mapping):
        raise RunLogError(f"{path}: the result record must be a JSON object")
    _require_schema_version(data, path)
    result = data.get("result")
    if not isinstance(result, Mapping):
        raise RunLogError(f"{path}: result must be a JSON object")
    return result


def _settled_result(events: tuple[SessionEvent, ...]) -> Mapping[str, Any] | None:
    """The Agent Result that `session_settled` carries, when result.json is missing."""
    if not events or events[-1].type != SETTLED_EVENT:
        return None
    result = events[-1].data.get("result")
    return result if isinstance(result, Mapping) else None


def _count(value: Any) -> int | None:
    # bool is an int in Python, and a token count is a whole number of tokens.
    return value if type(value) is int and value >= 0 else None


def _added(first: int | None, second: int | None) -> int | None:
    if second is None:
        return first
    return second if first is None else first + second


def _read_document(path: Path, *, missing: str) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise RunLogError(missing) from None
    except OSError as exc:
        raise RunLogError(f"cannot read {path}: {exc}") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise RunLogError(f"{path} is not valid JSON: {exc}") from exc


def _require_schema_version(
    data: Mapping[str, Any], path: Path, *, line: int | None = None
) -> None:
    version = data.get("schemaVersion")
    # `True == 1` in Python, so the type must be exactly int.
    if type(version) is int and version == SCHEMA_VERSION:
        return
    where = f"{path} line {line}" if line is not None else str(path)
    raise RunLogError(
        f"{where}: schemaVersion must be {SCHEMA_VERSION}, found {json.dumps(version)}; "
        "this adapter reads only that schema"
    )


def _event_of(data: Mapping[str, Any]) -> SessionEvent | None:
    session_id = data.get("sessionId")
    sequence = data.get("sequence")
    occurred_at = data.get("occurredAt")
    type_name = data.get("type")
    event_data = data.get("data")
    if (
        not isinstance(session_id, str)
        or type(sequence) is not int
        or not isinstance(occurred_at, str)
        or not isinstance(type_name, str)
        or not isinstance(event_data, Mapping)
    ):
        return None
    return SessionEvent(
        session_id=session_id,
        sequence=sequence,
        occurred_at=occurred_at,
        type=type_name,
        data=event_data,
    )


def _optional_text(data: Mapping[str, Any], key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) else None
