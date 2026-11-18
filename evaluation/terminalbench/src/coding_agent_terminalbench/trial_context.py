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

from coding_agent_terminalbench.run_log import LIMIT_REACHED_EVENT, RunLog, load_run_log
from coding_agent_terminalbench.trajectory import (
    AgentIdentity,
    build_trajectory,
    write_trajectory,
)

# Harbor reads the trajectory of an agent at `logs_dir / "trajectory.json"` (Harbor's
# `trial/trial.py`), so the file sits beside the directory of the run files, not inside it.
TRAJECTORY_FILE = "trajectory.json"


def populate_trial_context(
    context: AgentContext,
    run_dir: Path,
    *,
    trajectory_path: Path,
    agent: AgentIdentity,
    artifact_sha256: Mapping[str, str],
    installed_executable: str | None = None,
) -> None:
    """Reads `run_dir` into `context`, and writes the trajectory to `trajectory_path`.

    `installed_executable` is the file of the artifact that `install()` put in the container, or
    `None` when no install finished.

    The run files are read and the trajectory is built before the context is touched, so a log
    that cannot be read or converted leaves the context as it was found. Only writing the file can
    still fail afterwards.

    Raises `RunLogError` when the run files are missing or do not have the shape of ADR 0005 §4,
    and a validation error when the events cannot be represented in ATIF. The caller decides
    whether a trial survives either.
    """
    log = load_run_log(run_dir)
    trajectory = build_trajectory(log, agent=agent)
    _fill_usage(context, log)
    context.metadata = _metadata(log, artifact_sha256, installed_executable)
    write_trajectory(trajectory_path, trajectory)


def _fill_usage(context: AgentContext, log: RunLog) -> None:
    """Harbor's three token fields, from what the Agent Result recorded.

    Harbor defines `n_input_tokens` as including cached tokens, and the providers of this
    repository already count them there, except Anthropic: `packages/ai` reports its cache reads
    beside `input_tokens`, so for that provider the trial's input count is the uncached one.
    `n_cache_tokens` carries them either way, and cost stays unset because the provider contract
    carries no pricing (ADR 0005 §6).
    """
    tokens = log.usage
    context.n_input_tokens = tokens.input
    context.n_output_tokens = tokens.output
    context.n_cache_tokens = tokens.cached


def _metadata(
    log: RunLog, artifact_sha256: Mapping[str, str], installed_executable: str | None
) -> dict[str, Any]:
    """What the trial result names about the run (ADR 0005 §6)."""
    metadata: dict[str, Any] = {
        "model_turns": log.model_turns,
        "tool_calls": log.tool_calls,
        "profile": log.record.profile,
        # One hash per executable of the artifact, so the trial records every build the manifest
        # pins. The run files do not say which one ran: install() does, in installed_executable.
        "artifact_sha256": dict(artifact_sha256),
        "installed_executable": installed_executable,
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


def _limit_reached(log: RunLog) -> dict[str, Any] | None:
    """The runtime limit that ended the session, when one did."""
    for event in reversed(log.events):
        if event.type == LIMIT_REACHED_EVENT:
            return dict(event.data)
    return None
