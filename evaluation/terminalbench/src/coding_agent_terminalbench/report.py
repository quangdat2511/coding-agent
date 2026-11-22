"""Renders report.md for a recorded TerminalBench job (ADR 0005 §8).

report.md carries validity, the dataset pin, the mean reward over the job's N recorded outcomes
computed as Harbor's mean computes it, the reward distribution, the per-task table, the
cross-tabulation of Agent Result outcome against reward, every rerun-eligible trial with its reason
and its rerun's outcome, the harness-flaky tasks and the tasks whose declared MCP servers or skills
directory the adapter ignores. It has no Pi column and no pass or fail threshold.

The module renders only: record.py reads the job directories, computes the recorded outcomes and
validity, and passes its RecordData to build_report. The annotations below name that type without
importing it, so this module loads even while record.py is being imported.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from coding_agent_terminalbench.harbor_job import Trial
    from coding_agent_terminalbench.record import RecordData


# report.md: every section of ADR 0005 §8, and no pass threshold.


def format_reward(value: float | int) -> str:
    """A reward as report.md writes it, without losing the value that Harbor computed."""
    if isinstance(value, int):
        return str(value)
    return format(value, ".12g")


def format_rewards(reward: Mapping[str, float | int] | None) -> str:
    """A recorded reward dict as report.md writes it."""
    if reward is None:
        return "no reward"
    if len(reward) == 1:
        return format_reward(next(iter(reward.values())))
    return ", ".join(f"{key}={format_reward(value)}" for key, value in sorted(reward.items()))


def format_optional(value: Any) -> str:
    return "—" if value is None else str(value)


def format_seconds(seconds: float | None) -> str:
    return "—" if seconds is None else f"{seconds:.1f}"


def clean_cell(text: str) -> str:
    """A table cell that cannot break its row."""
    return text.replace("|", "\\|").replace("\n", " ")


def markdown_table(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> list[str]:
    lines = [
        "| " + " | ".join(headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    lines.extend(
        "| " + " | ".join(clean_cell(str(cell)) for cell in row) + " |" for row in rows
    )
    return lines


def agent_outcome_label(trial: Trial | None) -> str:
    """The Agent Result outcome of a trial, or the reason there is none."""
    if trial is None or trial.outcome is None or trial.outcome.outcome is None:
        return "no Agent Result"
    return trial.outcome.outcome


def reward_sort_key(label: str) -> tuple[int, float, str]:
    """Order the report's reward labels: the numbers ascending, then the rest, then no reward."""
    if label == "no reward":
        return (2, 0.0, label)
    try:
        return (0, float(label.split("=")[-1]), label)
    except ValueError:
        return (1, 0.0, label)


def recorded_reward_labels(data: RecordData) -> list[str]:
    labels = {
        format_rewards(outcome.recorded.reward if outcome.recorded is not None else None)
        for outcome in data.outcomes
    }
    return sorted(labels, key=reward_sort_key)


def validity_section(data: RecordData) -> list[str]:
    count = len(data.outcomes)
    lines = ["## Validity", ""]
    if data.valid:
        lines.append(
            f"**Valid.** Every one of the {count} tasks has a completed trial in the recorded "
            "job or the rerun job, and the dataset record shows the properties ADR 0008 §3 "
            "requires. The result below is the job's headline result."
        )
    else:
        lines.append(
            "**Not valid.** ADR 0005 §7 makes a job valid only when every task has a completed "
            "trial in the recorded job or the rerun job, and the dataset has the properties "
            "ADR 0008 §3 requires. No headline reward is published. The problems are:"
        )
        lines.append("")
        lines.extend(f"- {problem}" for problem in data.validity_problems)
    lines.append("")
    return lines


def waivers_section(data: RecordData) -> list[str]:
    """The protocol requirements this record waives, and why (ADR 0005 §7 and §9)."""
    entries = [
        *(
            [f"- **Credential isolation**: {data.isolation_waiver}"]
            if data.isolation_waiver is not None
            else []
        ),
        *(
            [f"- **Dataset release tag**: {data.release_tag_waiver}"]
            if data.release_tag_waiver is not None
            else []
        ),
        *(
            [f"- **Timeout override**: {data.timeout_waiver}"]
            if data.timeout_waiver is not None
            else []
        ),
    ]
    if not entries:
        return []
    return [
        "## Waivers",
        "",
        "This record waives a requirement of ADR 0005 §7, so it does not count under §9 "
        "criterion 5 and is not the MVP's recorded job:",
        "",
        *entries,
        "",
    ]


def dataset_section_report(data: RecordData) -> list[str]:
    dataset = data.dataset
    if data.release_tag_waiver is None:
        pin = (
            f"The job ran {dataset.identifier}, whose source repository is "
            f"{dataset.source_repository} and whose {dataset.release_tag} tag the record says "
            f"resolves to commit {data.release_commit}."
        )
    else:
        pin = (
            f"The job ran {dataset.identifier}, whose source repository is "
            f"{dataset.source_repository} and whose record names commit {data.release_commit}. "
            f"The record waives resolving that commit from a release tag: "
            f"{data.release_tag_waiver}."
        )
    lines = [
        "## Dataset",
        "",
        pin,
        "",
        f"N is {len(data.outcomes)}, the number of tasks in the job's resolved task list, not a "
        "constant: ADR 0008 makes the dataset a job parameter and derives every count from the "
        "job.",
        "",
        f"Its result is comparable only with jobs on {dataset.identifier}, and is never pooled "
        "with the result of another dataset pin.",
        "",
        f"The dataset's own data comes from its committed record, {dataset.path}; manifest.json "
        "copies the record's rows and the evidence for the properties ADR 0008 §3 requires.",
        "",
    ]
    if dataset.smoke_tasks:
        lines.append("Smoke set: " + ", ".join(dataset.smoke_tasks) + ".")
    else:
        lines.append("The dataset record names no smoke set.")
    lines.append("")
    rows = [
        (entry["label"], entry["evidence"] or "not recorded", "yes" if entry["shown"] else "no")
        for entry in data.properties
    ]
    lines.extend(markdown_table(("Property", "Evidence", "Shown"), rows))
    lines.append("")
    return lines


def result_section(data: RecordData) -> list[str]:
    count = len(data.outcomes)
    lines = ["## Result", ""]
    if len(data.mean) <= 1:
        value = data.mean.get("mean")
        text = "—" if value is None else format_reward(value)
    else:
        text = ", ".join(
            f"{key}={format_reward(value)}" for key, value in sorted(data.mean.items())
        )
    if data.valid:
        lines.append(f"**Mean reward: {text} over the {count} recorded outcomes.**")
        lines.append("")
        lines.append(
            "It is computed as Harbor's mean computes it: a trial without a verifier reward "
            "counts as 0. The distribution is below."
        )
    else:
        lines.append("**No headline reward:** the job is not valid (ADR 0005 §7).")
        lines.append("")
        lines.append(
            f"For diagnosis only, the mean over the {count} recorded outcomes is {text}, "
            "counting a trial without a verifier reward as 0."
        )
    lines.append("")
    return lines


def distribution_section(data: RecordData) -> list[str]:
    counts = Counter(
        format_rewards(outcome.recorded.reward if outcome.recorded is not None else None)
        for outcome in data.outcomes
    )
    labels = recorded_reward_labels(data)
    rows = [(label, counts[label]) for label in labels]
    lines = ["## Reward distribution", ""]
    lines.extend(markdown_table(("Recorded reward", "Tasks"), rows))
    lines.append("")
    return lines


PER_TASK_HEADERS = (
    "Task",
    "Reward",
    "Source",
    "Agent Result",
    "Failure code",
    "Model Turns",
    "Tool Calls",
    "Input tokens",
    "Cache tokens",
    "Output tokens",
    "Duration (s)",
    "Trial exception",
)


def per_task_section(data: RecordData) -> list[str]:
    rows = []
    for outcome in data.outcomes:
        trial = outcome.recorded
        if trial is None:
            missing = ["—"] * (len(PER_TASK_HEADERS) - 2)
            rows.append((outcome.task, "no recorded outcome", *missing))
            continue
        failure = trial.outcome.failure_code if trial.outcome is not None else None
        rows.append(
            (
                outcome.task,
                format_rewards(trial.reward),
                "rerun" if outcome.from_rerun else "recorded",
                agent_outcome_label(trial),
                format_optional(failure),
                format_optional(trial.model_turns),
                format_optional(trial.tool_calls),
                format_optional(trial.input_tokens),
                format_optional(trial.cache_tokens),
                format_optional(trial.output_tokens),
                format_seconds(trial.duration_seconds),
                format_optional(trial.exception_type),
            )
        )
    lines = ["## Per-task results", ""]
    lines.extend(markdown_table(PER_TASK_HEADERS, rows))
    lines.append("")
    return lines


def cross_tabulation_section(data: RecordData) -> list[str]:
    labels = recorded_reward_labels(data)
    outcome_labels = sorted({agent_outcome_label(outcome.recorded) for outcome in data.outcomes})
    rows = []
    for outcome_label in outcome_labels:
        counts = Counter(
            format_rewards(outcome.recorded.reward if outcome.recorded is not None else None)
            for outcome in data.outcomes
            if agent_outcome_label(outcome.recorded) == outcome_label
        )
        rows.append((outcome_label, *[counts[label] for label in labels]))
    lines = ["## Agent Result against reward", ""]
    lines.extend(markdown_table(("Agent Result", *labels), rows) if labels else ["No outcomes."])
    lines.append("")
    return lines


def rerun_section(data: RecordData) -> list[str]:
    lines = ["## Rerun-eligible trials", ""]
    eligible = data.rerun_eligible
    if not eligible:
        lines.append(
            "None. Every trial has a verifier reward and no MODEL_FAILURE whose details record "
            "an HTTP 401, 403, 429 or 5xx from the provider (ADR 0005 §7)."
        )
        lines.append("")
        return lines
    reruns = data.rerun_trials()
    rows = []
    for outcome in eligible:
        rerun = reruns.get(outcome.task)
        rows.append(
            (
                outcome.task,
                outcome.original.rerun_reason or "rerun-eligible",
                format_rewards(rerun.reward) if rerun is not None else "no rerun trial",
                agent_outcome_label(rerun) if rerun is not None else "—",
                format_optional(rerun.exception_type) if rerun is not None else "—",
            )
        )
    lines.extend(
        markdown_table(
            (
                "Task",
                "Why it was rerun-eligible",
                "Rerun reward",
                "Rerun Agent Result",
                "Rerun exception",
            ),
            rows,
        )
    )
    lines.append("")
    return lines


def harness_flaky_section(data: RecordData) -> list[str]:
    lines = [
        "## Harness-flaky tasks",
        "",
        f"From the oracle job {data.oracle.job} (ADR 0005 §7 step 2).",
        "",
    ]
    if not data.oracle.harness_flaky:
        lines.append("None. Every task's oracle reward is 1.")
        lines.append("")
        return lines
    rows = []
    for entry in data.oracle.harness_flaky:
        reward = entry.get("reward")
        rows.append(
            (
                entry.get("name", "—"),
                "no reward" if reward is None else format_reward(reward),
                format_optional(entry.get("exceptionType")),
            )
        )
    lines.extend(markdown_table(("Task", "Oracle reward", "Oracle exception"), rows))
    lines.append("")
    return lines


def ignored_declarations_section(data: RecordData) -> list[str]:
    lines = ["## Ignored MCP servers and skills", ""]
    mcp = set(data.dataset.mcp_server_tasks)
    skills = set(data.dataset.skills_tasks)
    if not mcp and not skills:
        lines.append("None recorded in the dataset record.")
        lines.append("")
        return lines
    for task in sorted(mcp | skills):
        declared = []
        if task in mcp:
            declared.append("an MCP server")
        if task in skills:
            declared.append("a skills directory")
        lines.append(
            f"- {task} declares {' and '.join(declared)}; the adapter passes no MCP configuration "
            "and no skills directory, because MCP and skills are outside the MVP (ADR 0005 §5)."
        )
    lines.append("")
    return lines


def build_report(data: RecordData) -> str:
    """The report.md of ADR 0005 §8: every section it lists, and no pass or fail threshold."""
    job = data.recorded
    profile_name = data.profile_name
    provider, model = data.provider, data.model
    lines = [
        f"# Recorded TerminalBench job: {job.name}",
        "",
        f"- Dataset pin: {data.dataset.identifier}",
        f"- Release commit: {data.release_commit}",
        f"- Evaluation Profile: {format_optional(profile_name)}",
        f"- Provider and model: {format_optional(provider)}/{format_optional(model)}",
        f"- Coding Agent artifact: {data.artifact.version} {data.artifact.commit}",
        f"- Validity: {'valid' if data.valid else 'not valid'}",
        "",
        "The report has no pass or fail threshold and no Pi column: ADR 0005 §8 makes the Harbor "
        "reward the only success measure, and a later Pi run under the same pins is outside this "
        "protocol.",
        "",
    ]
    lines.extend(validity_section(data))
    lines.extend(waivers_section(data))
    lines.extend(dataset_section_report(data))
    lines.extend(result_section(data))
    lines.extend(distribution_section(data))
    lines.extend(per_task_section(data))
    lines.extend(cross_tabulation_section(data))
    lines.extend(rerun_section(data))
    lines.extend(harness_flaky_section(data))
    lines.extend(ignored_declarations_section(data))
    return "\n".join(lines)

