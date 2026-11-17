"""Converts the event log into an ATIF trajectory (ADR 0005 §6).

ATIF is Harbor's format and moves with Harbor, so the writer lives beside the Harbor pin instead
of in the TypeScript packages: one module here absorbs that churn. The conversion follows the table
of ADR 0005 §6, and a document is written only after Harbor's `Trajectory` model accepts it.

A log that does not end with `session_settled` is truncated (ADR 0005 §4) and still converts: the
steps of the events that were written are kept, and the Agent Result fields are left out.

The Assistant Message of Coding Agent holds text and Tool Calls only, so ATIF's displayable
reasoning is always absent: the providers' reasoning tokens are counted, not transcribed.
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)

from coding_agent_terminalbench.run_log import (
    CALL_COMPLETED_EVENT,
    CALL_QUEUED_EVENT,
    FEEDBACK_EVENT,
    MESSAGE_COMPLETED_EVENT,
    TASK_EVENT,
    TURN_COMPLETED_EVENT,
    TURN_STARTED_EVENT,
    RunLog,
    SessionEvent,
    TokenCounts,
    count_of,
    events_of_type,
    text_of,
    tokens_of,
)

# The Assistant Message and Verification outcomes of packages/agent-core/src/events.ts.
COMPLETED_OUTCOME = "completed"
CONTINUE_OUTCOME = "continue"


@dataclass(frozen=True)
class AgentIdentity:
    """The agent an ATIF trajectory names: what ran, and which build of it."""

    name: str
    version: str


def build_trajectory(log: RunLog, *, agent: AgentIdentity) -> Trajectory:
    """Builds the trajectory of `log`, validating it against Harbor's model as it goes."""
    queued_calls = _queued_calls(log.events)
    completed_calls = _completed_calls(log.events)
    usages = _turn_usages(log.events)

    steps = [Step(step_id=1, source="system", message=log.record.system_prompt)]
    current_turn: str | None = None
    for event in log.events:
        data = event.data
        if event.type == TURN_STARTED_EVENT:
            current_turn = text_of(data.get("modelTurnId"))
        elif event.type == TURN_COMPLETED_EVENT:
            current_turn = None
        elif event.type == TASK_EVENT:
            objective = _objective_of(data)
            if objective is not None:
                steps.append(_user_step(len(steps) + 1, event, objective))
        elif event.type == MESSAGE_COMPLETED_EVENT:
            step = _agent_step(
                len(steps) + 1, event, current_turn, queued_calls, completed_calls, usages
            )
            steps.append(step)
        elif event.type == FEEDBACK_EVENT and data.get("outcome") == CONTINUE_OUTCOME:
            feedback = _user_message_text(data.get("feedback"))
            if feedback is not None:
                steps.append(_user_step(len(steps) + 1, event, feedback))

    return Trajectory(
        session_id=log.session_id,
        agent=Agent(name=agent.name, version=agent.version, model_name=_model_name(log)),
        steps=steps,
        final_metrics=_final_metrics(log, steps),
    )


def write_trajectory(path: Path, trajectory: Trajectory) -> None:
    """Writes the document, but only once Harbor's model accepts what would be written.

    The check is on the text, not on the object, so a field that serialization drops or renames
    cannot reach the file. The document is renamed into place like the files of a run, so Harbor
    never reads half of one when a write fails part way through.
    """
    text = f"{json.dumps(trajectory.to_json_dict(exclude_none=True), indent=2)}\n"
    Trajectory.model_validate_json(text)
    partial = path.with_name(f"{path.name}.partial")
    try:
        partial.write_text(text, encoding="utf-8")
        partial.replace(path)
    except OSError:
        partial.unlink(missing_ok=True)
        raise


def _user_step(step_id: int, event: SessionEvent, message: str) -> Step:
    return Step(step_id=step_id, source="user", timestamp=event.occurred_at, message=message)


def _agent_step(
    step_id: int,
    event: SessionEvent,
    model_turn: str | None,
    queued_calls: Mapping[tuple[str, str], str],
    completed_calls: Mapping[str, Mapping[str, Any]],
    usages: Mapping[str, Mapping[str, Any]],
) -> Step:
    blocks = _content_blocks(event.data.get("message"))
    calls = [
        call
        for block in blocks
        if (call := _tool_call(block, model_turn, queued_calls)) is not None
    ]
    results = [
        _observation_result(call.tool_call_id, completed_calls[call.tool_call_id])
        for call in calls
        if call.tool_call_id in completed_calls
    ]
    usage = usages.get(model_turn) if model_turn is not None else None
    return Step(
        step_id=step_id,
        source="agent",
        timestamp=event.occurred_at,
        message=_text_of_blocks(blocks),
        tool_calls=calls or None,
        observation=Observation(results=results) if results else None,
        metrics=_metrics_of(usage) if usage is not None else None,
        extra=_message_extra(event.data),
    )


def _tool_call(
    block: Mapping[str, Any], model_turn: str | None, queued_calls: Mapping[tuple[str, str], str]
) -> ToolCall | None:
    """The Tool Call of an Assistant Message, under its Agent Core id (ADR 0005 §6)."""
    if block.get("type") != "tool_call":
        return None
    function_name = text_of(block.get("name"))
    if function_name is None:
        return None
    provider_id = text_of(block.get("toolCallId"))
    # `tool_call_queued` gives the Agent Core id of the call, but it arrives after the message that
    # issued it, so it is looked up rather than read in order. A truncated log may not have it yet,
    # and then the provider's id is the only id the call has.
    call_id = queued_calls.get((model_turn, provider_id)) if model_turn else None
    if not isinstance(call_id, str):
        call_id = provider_id
    if call_id is None:
        return None
    return ToolCall(
        tool_call_id=call_id,
        function_name=function_name,
        arguments=_arguments(block.get("arguments")),
    )


def _arguments(raw: Any) -> dict[str, Any]:
    """The Tool Call arguments as a JSON object, keeping text that is not one."""
    if isinstance(raw, Mapping):
        return dict(raw)
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {"raw": raw}
        if isinstance(parsed, Mapping):
            return dict(parsed)
        return {"raw": raw}
    return {}


def _observation_result(call_id: str, data: Mapping[str, Any]) -> ObservationResult:
    """The Tool Call's observation, whether or not a Tool Result arrived.

    `closeModelTurn` records `tool_call_completed` with an outcome and no `result` for a call that
    failed or was cancelled, so the outcome is kept even when there is no content to show.
    """
    extra: dict[str, Any] = {"outcome": data.get("outcome")}
    reason = text_of(data.get("reason"))
    if reason is not None:
        extra["reason"] = reason
    content: str | None = None
    result = data.get("result")
    if isinstance(result, Mapping):
        content = text_of(result.get("content"))
        error = result.get("error")
        if isinstance(error, Mapping):
            extra["error"] = {"code": error.get("code"), "message": error.get("message")}
    return ObservationResult(source_call_id=call_id, content=content, extra=extra)


def _message_extra(data: Mapping[str, Any]) -> dict[str, Any] | None:
    """The outcome of an Assistant Message that failed or was cancelled (ADR 0005 §6)."""
    outcome = text_of(data.get("outcome"))
    if outcome is None or outcome == COMPLETED_OUTCOME:
        return None
    extra: dict[str, Any] = {"outcome": outcome}
    failure = data.get("failure")
    if isinstance(failure, Mapping):
        extra["failure"] = dict(failure)
    return extra


def _metrics_of(usage: Mapping[str, Any]) -> Metrics | None:
    """The metrics of one Model Turn: its usage, with no cost, because the provider has none."""
    tokens = tokens_of(usage)
    reasoning = count_of(usage, "reasoningTokens")
    if tokens == TokenCounts() and reasoning is None:
        return None
    return Metrics(
        prompt_tokens=tokens.input,
        completion_tokens=tokens.output,
        cached_tokens=tokens.cached,
        extra={"reasoning_tokens": reasoning} if reasoning is not None else None,
    )


def _final_metrics(log: RunLog, steps: list[Step]) -> FinalMetrics:
    """The totals of the Agent Result, with its outcome and failure (ADR 0005 §6)."""
    tokens = log.usage
    extra: dict[str, Any] = {}
    if log.agent_result is not None:
        outcome = text_of(log.agent_result.get("outcome"))
        if outcome is not None:
            extra["outcome"] = outcome
        for key in ("failure", "cancellation"):
            value = log.agent_result.get(key)
            if isinstance(value, Mapping):
                extra[key] = dict(value)
    if log.truncated:
        extra["truncated"] = True
    return FinalMetrics(
        total_prompt_tokens=tokens.input,
        total_completion_tokens=tokens.output,
        total_cached_tokens=tokens.cached,
        total_steps=len(steps),
        extra=extra or None,
    )


def _queued_calls(events: tuple[SessionEvent, ...]) -> dict[tuple[str, str], str]:
    """The Agent Core id of every queued Tool Call, by Model Turn and provider id."""
    queued: dict[tuple[str, str], str] = {}
    for event in events_of_type(events, CALL_QUEUED_EVENT):
        model_turn = text_of(event.data.get("modelTurnId"))
        call = event.data.get("toolCall")
        if model_turn is None or not isinstance(call, Mapping):
            continue
        provider_id = text_of(call.get("providerId"))
        call_id = text_of(call.get("id"))
        if provider_id is not None and call_id is not None:
            queued[(model_turn, provider_id)] = call_id
    return queued


def _completed_calls(events: tuple[SessionEvent, ...]) -> dict[str, Mapping[str, Any]]:
    """The `tool_call_completed` data of every Tool Call, by Agent Core id."""
    completed: dict[str, Mapping[str, Any]] = {}
    for event in events_of_type(events, CALL_COMPLETED_EVENT):
        call_id = text_of(event.data.get("toolCallId"))
        if call_id is not None:
            completed[call_id] = event.data
    return completed


def _turn_usages(events: tuple[SessionEvent, ...]) -> dict[str, Mapping[str, Any]]:
    """The usage of every completed Model Turn, by Model Turn id."""
    usages: dict[str, Mapping[str, Any]] = {}
    for event in events_of_type(events, TURN_COMPLETED_EVENT):
        model_turn = text_of(event.data.get("modelTurnId"))
        usage = event.data.get("usage")
        if model_turn is not None and isinstance(usage, Mapping):
            usages[model_turn] = usage
    return usages


def _objective_of(data: Mapping[str, Any]) -> str | None:
    task = data.get("task")
    return text_of(task.get("objective")) if isinstance(task, Mapping) else None


def _content_blocks(message: Any) -> tuple[Mapping[str, Any], ...]:
    content = message.get("content") if isinstance(message, Mapping) else None
    if not isinstance(content, Sequence) or isinstance(content, str):
        return ()
    return tuple(block for block in content if isinstance(block, Mapping))


def _text_of_blocks(blocks: tuple[Mapping[str, Any], ...]) -> str:
    """The text of a message's blocks, as Harbor's own converters join it."""
    return "\n".join(
        text
        for block in blocks
        if block.get("type") == "text" and (text := text_of(block.get("text"))) is not None
    )


def _user_message_text(feedback: Any) -> str | None:
    """The text of a User Message, whose content is a string or a list of blocks."""
    if not isinstance(feedback, Mapping):
        return None
    content = feedback.get("content")
    text = text_of(content)
    if text is not None:
        return text
    blocks = _content_blocks(feedback)
    if not blocks:
        return None
    # A Tool Result block in a User Message carries its content under a different key.
    parts = [
        part
        for block in blocks
        if (part := text_of(block.get("text") or block.get("content"))) is not None
    ]
    return "\n".join(parts)


def _model_name(log: RunLog) -> str | None:
    provider = log.record.provider
    model = log.record.model
    if provider is not None and model is not None:
        return f"{provider}/{model}"
    return model or provider


