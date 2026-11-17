"""Fills a Harbor Agent Context from the files a run wrote (ADR 0005 §6).

Harbor downloads the agent's logs after the trial, then calls `populate_context_post_run` on the
agent, and only when `run()` left the context empty. This module turns the three files of
ADR 0005 §4 into the token counts, the metadata and the ATIF trajectory that make a trial
inspectable in Harbor's own tooling.

It reads files only: no network, no Harbor job, and no Coding Agent process.
"""

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from harbor.models.agent.context import AgentContext

from coding_agent_terminalbench.run_log import (
    CALL_QUEUED_EVENT,
    LIMIT_REACHED_EVENT,
    TURN_STARTED_EVENT,
    RunLog,
    load_run_log,
)
from coding_agent_terminalbench.trajectory import build_trajectory, write_trajectory

# Harbor reads the trajectory of an agent at `logs_dir / "trajectory.json"` (Harbor's
# `trial/trial.py`), so the file sits beside the directory of the run files, not inside it.
TRAJECTORY_FILE = "trajectory.json"


def populate_trial_context(
    context: AgentContext,
    run_dir: Path,
    *,
    trajectory_path: Path,
    agent_name: str,
    agent_version: str,
    artifact_sha256: Mapping[str, str],
) -> None:
    """Reads `run_dir` into `context`, and writes the trajectory to `trajectory_path`.

    Raises `RunLogError` when the run files are missing or do not have the shape of ADR 0005 §4,
    and a validation error when the events cannot be represented in ATIF. The caller decides
    whether a trial survives either.
    """
    log = load_run_log(run_dir)
    tokens = log.usage
    context.n_input_tokens = tokens.input
    context.n_output_tokens = tokens.output
    context.n_cache_tokens = tokens.cached
    # ADR 0005 §6 leaves the cost unset: the provider contract carries no pricing.
    context.metadata = _metadata(log, artifact_sha256)
    write_trajectory(
        trajectory_path,
        build_trajectory(log, agent_name=agent_name, agent_version=agent_version),
    )


def _metadata(log: RunLog, artifact_sha256: Mapping[str, str]) -> dict[str, Any]:
    """What the trial result names about the run (ADR 0005 §6)."""
    metadata: dict[str, Any] = {
        "model_turns": _event_count(log, TURN_STARTED_EVENT),
        "tool_calls": _event_count(log, CALL_QUEUED_EVENT),
        "profile": log.record.profile,
        # One hash per executable of the artifact. The run files do not say which architecture the
        # container selected, so the trial records every build the manifest pins.
        "artifact_sha256": dict(artifact_sha256),
        "truncated": log.truncated,
    }
    result = log.agent_result
    if result is not None:
        outcome = result.get("outcome")
        if isinstance(outcome, str):
            metadata["outcome"] = outcome
        failure = result.get("failure")
        code = failure.get("code") if isinstance(failure, Mapping) else None
        if isinstance(code, str):
            metadata["failure_code"] = code
    limit = _limit_reached(log)
    if limit is not None:
        metadata["limit_reached"] = limit
    return {key: value for key, value in metadata.items() if value is not None}


def _event_count(log: RunLog, type_name: str) -> int:
    return sum(1 for event in log.events if event.type == type_name)


def _limit_reached(log: RunLog) -> dict[str, Any] | None:
    """The runtime limit that ended the session, when one did."""
    for event in reversed(log.events):
        if event.type == LIMIT_REACHED_EVENT:
            return dict(event.data)
    return None
