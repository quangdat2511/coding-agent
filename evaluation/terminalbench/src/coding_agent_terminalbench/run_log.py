"""Reads the files a run writes: run.json, events.jsonl and result.json (ADR 0005 §4).

The three files are the external contract of `coding-agent run`, so this module follows
`packages/coding-agent/src/run-files.ts` and the envelopes of
`packages/agent-core/src/events.ts`. A change there changes this module in the same pull request.
"""

import json
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RUN_FILE = "run.json"

EVENTS_FILE = "events.jsonl"

RESULT_FILE = "result.json"

# ADR 0005 §4: all three files carry this schema version.
SCHEMA_VERSION = 2

# The Run Events that the adapter reads, from packages/agent-core/src/events.ts.
TASK_EVENT = "run_started"
TURN_STARTED_EVENT = "model_turn_started"
TURN_COMPLETED_EVENT = "model_turn_completed"
MESSAGE_COMPLETED_EVENT = "assistant_message_completed"
CALL_QUEUED_EVENT = "tool_call_queued"
CALL_COMPLETED_EVENT = "tool_call_completed"
FEEDBACK_EVENT = "verification_completed"
LIMIT_REACHED_EVENT = "runtime_limit_reached"
SETTLED_EVENT = "run_settled"


class RunLogError(ValueError):
    """The run directory has no run.json, or a file does not have the shape ADR 0005 §4 fixes."""


@dataclass(frozen=True)
class RunRecord:
    """The part of run.json that the adapter reads (ADR 0005 §4)."""

    system_prompt: str
    provider: str | None
    model: str | None
    profile: str | None


@dataclass(frozen=True)
class RunEvent:
    """One line of events.jsonl, in the envelope of ADR 0002."""

    run_id: str
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


@dataclass(frozen=True)
class RunLog:
    """The files of one run, as the adapter reads them."""

    record: RunRecord
    events: tuple[RunEvent, ...]
    # The Agent Result from result.json, or from the settled event when that file is missing.
    agent_result: Mapping[str, Any] | None

    @property
    def run_id(self) -> str | None:
        return self.events[0].run_id if self.events else None

    @property
    def truncated(self) -> bool:
        """Whether the log stops before the Agent Run settled (ADR 0005 §4).

        The writer is an ordinary consumer that the producer never awaits, so a killed process
        loses the tail. A log that does not end with `run_settled` is truncated.
        """
        return not self.events or self.events[-1].type != SETTLED_EVENT

    @property
    def usage(self) -> TokenCounts:
        """The token counts of the run, as the Agent Result records them.

        The Agent Result is the authority when there is one. A killed process loses the tail of the
        log and never writes result.json, so the usage of each completed Model Turn is summed then,
        which is the case that ADR 0005 §6 sends to the events. A log truncated by a failed append
        can still have a result.json, and that file is the more complete record of the Agent Run.
        """
        if self.agent_result is not None:
            return tokens_of(self.agent_result.get("usage"))
        tokens = TokenCounts()
        for event in events_of_type(self.events, TURN_COMPLETED_EVENT):
            tokens = tokens.plus(tokens_of(event.data.get("usage")))
        return tokens

    @property
    def model_turns(self) -> int:
        """How many Model Turns the Agent Run started."""
        return sum(1 for _ in events_of_type(self.events, TURN_STARTED_EVENT))

    @property
    def tool_calls(self) -> int:
        """How many Tool Calls the Agent Run queued."""
        return sum(1 for _ in events_of_type(self.events, CALL_QUEUED_EVENT))


def load_run_log(directory: Path) -> RunLog:
    """Reads the three files that `coding-agent run --output-dir` wrote into `directory`."""
    record = _read_record(directory / RUN_FILE)
    events = _read_events(directory / EVENTS_FILE)
    agent_result = _read_result(directory / RESULT_FILE)
    if agent_result is None:
        agent_result = _settled_result(events)
    return RunLog(record=record, events=events, agent_result=agent_result)


def events_of_type(events: Iterable[RunEvent], type_name: str) -> Iterator[RunEvent]:
    """The events of one type, in the order the log holds them."""
    return (event for event in events if event.type == type_name)


def tokens_of(usage: Any) -> TokenCounts:
    """The counts of a `UsageTotals` object, as run.json, result.json and the events write it."""
    if not isinstance(usage, Mapping):
        return TokenCounts()
    return TokenCounts(
        input=count_of(usage, "inputTokens"),
        output=count_of(usage, "outputTokens"),
        cached=count_of(usage, "cachedInputTokens"),
    )


def count_of(usage: Mapping[str, Any], key: str) -> int | None:
    """A whole, non-negative count of a usage object, or None when it is absent or malformed."""
    value = usage.get(key)
    # bool is an int in Python, and a token count is a whole number of tokens.
    return value if type(value) is int and value >= 0 else None


def text_of(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _read_record(path: Path) -> RunRecord:
    data = _parse_json(
        _decode_utf8(
            _read_required(
                path,
                missing=(
                    f"{path} does not exist; the adapter reads the directory that "
                    "`coding-agent run --output-dir` wrote"
                ),
            ),
            path,
        ),
        path,
    )
    if not isinstance(data, Mapping):
        raise RunLogError(f"{path}: the run record must be a JSON object")
    _require_schema_version(data, path)
    system_prompt = data.get("systemPrompt")
    if not isinstance(system_prompt, str):
        raise RunLogError(f"{path}: systemPrompt must be a string")
    return RunRecord(
        system_prompt=system_prompt,
        provider=_optional_text(data, "provider"),
        model=_optional_text(data, "model"),
        profile=_optional_text(data, "profile"),
    )


def _read_events(path: Path) -> tuple[RunEvent, ...]:
    raw = _read_optional(path)
    if raw is None:
        return ()

    # The writer appends one line per event and stops after a failed write, so only the last line
    # can be a write the process never finished. Splitting the bytes is safe because byte 0x0A
    # never occurs inside a multi byte UTF-8 character, so a line cut inside a character fails to
    # decode alone instead of taking the whole log with it. `str.splitlines` would also split on
    # U+2028 and U+0085, which JSON.stringify leaves inside a string.
    lines = raw.split(b"\n")
    last = max((index for index, line in enumerate(lines) if line.strip()), default=-1)
    events: list[RunEvent] = []
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            data = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            if index == last:
                return tuple(events)
            raise RunLogError(
                f"{path} line {index + 1} is not a whole Run Event: {exc}"
            ) from exc
        if not isinstance(data, Mapping):
            if index == last:
                return tuple(events)
            raise RunLogError(f"{path} line {index + 1} is not a JSON object")
        _require_schema_version(data, path, line=index + 1)
        event = _event_of(data)
        if event is None:
            if index == last:
                return tuple(events)
            raise RunLogError(
                f"{path} line {index + 1} does not have the Run Event envelope"
            )
        events.append(event)
    return tuple(events)


def _read_result(path: Path) -> Mapping[str, Any] | None:
    raw = _read_optional(path)
    if raw is None:
        # A run settles before it writes result.json, so the file is missing when it was killed.
        return None
    data = _parse_json(_decode_utf8(raw, path), path)
    if not isinstance(data, Mapping):
        raise RunLogError(f"{path}: the result record must be a JSON object")
    _require_schema_version(data, path)
    result = data.get("result")
    if not isinstance(result, Mapping):
        raise RunLogError(f"{path}: result must be a JSON object")
    return result


def _read_optional(path: Path) -> bytes | None:
    """The bytes of a file that a killed run may not have written, or None when it is missing."""
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RunLogError(f"cannot read {path}: {exc}") from exc


def _read_required(path: Path, *, missing: str) -> bytes:
    raw = _read_optional(path)
    if raw is None:
        raise RunLogError(missing)
    return raw


def _decode_utf8(raw: bytes, path: Path) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RunLogError(f"{path} is not valid UTF-8: {exc}") from exc


def _parse_json(text: str, path: Path) -> Any:
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise RunLogError(f"{path} is not valid JSON: {exc}") from exc


def _settled_result(events: tuple[RunEvent, ...]) -> Mapping[str, Any] | None:
    """The Agent Result that `run_settled` carries, when result.json is missing."""
    if not events or events[-1].type != SETTLED_EVENT:
        return None
    result = events[-1].data.get("result")
    return result if isinstance(result, Mapping) else None


def _added(first: int | None, second: int | None) -> int | None:
    if second is None:
        return first
    return second if first is None else first + second


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


def _event_of(data: Mapping[str, Any]) -> RunEvent | None:
    run_id = data.get("runId")
    sequence = data.get("sequence")
    occurred_at = data.get("occurredAt")
    type_name = data.get("type")
    event_data = data.get("data")
    if (
        not isinstance(run_id, str)
        or type(sequence) is not int
        or not isinstance(occurred_at, str)
        or not isinstance(type_name, str)
        or not isinstance(event_data, Mapping)
    ):
        return None
    return RunEvent(
        run_id=run_id,
        sequence=sequence,
        occurred_at=occurred_at,
        type=type_name,
        data=event_data,
    )


def _optional_text(data: Mapping[str, Any], key: str) -> str | None:
    return text_of(data.get(key))
