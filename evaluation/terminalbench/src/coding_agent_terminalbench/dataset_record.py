"""Reads a committed dataset record (ADR 0008 §1 and §4).

ADR 0008 §1 makes the evaluation dataset a job parameter and puts each dataset's own data in a
committed record: ADR 0008 §4 for the default pin, and
evaluation/terminalbench/datasets/<org>/<name>@<version>.md for any other admissible dataset. A
record is Markdown with a two-column table whose rows ADR 0008 §4 shows. This module reads those
rows, so the record tooling takes the dataset the job actually ran from its record rather than from
a constant in this repository.

The rows this module needs, with the label of ADR 0008 §4:

- Dataset identifier, Source repository, Release tag and Release commit: the pin.
- Smoke tasks: the dataset's smoke set (ADR 0008 §3 property 5).
- Environment, Single step, Verifier environment and Per-task agent timeout: the evidence for
  ADR 0008 §3 properties 1 to 4.
- Tasks with declared MCP servers and Tasks with a declared skills directory: optional. They name
  the tasks whose declared MCP servers or skills directory the adapter ignores, which the recorded
  job's report names (ADR 0005 §5 and §8).

A missing pin row is an error: without a record the dataset is not admissible (ADR 0008 §1). A
missing evidence row is not an error here; the job is then invalid under ADR 0005 §7, and the
report says so, because ADR 0005 §8 records the evidence that ADR 0008 §3 requires.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

# The row labels of ADR 0008 §4. A label is compared after normalizing whitespace, Markdown
# emphasis and code spans, so a record file may write the label in any of those forms.
IDENTIFIER_LABEL = "dataset identifier"
SOURCE_REPOSITORY_LABEL = "source repository"
RELEASE_TAG_LABEL = "release tag"
RELEASE_COMMIT_LABEL = "release commit"
SMOKE_TASKS_LABEL = "smoke tasks"
MCP_SERVERS_LABEL = "tasks with declared mcp servers"
SKILLS_DIRECTORY_LABEL = "tasks with a declared skills directory"

# ADR 0008 §3 properties 1 to 4: the stable name that manifest.json and report.md use, and the
# label of the row that records the evidence for each.
PROPERTY_ROWS: tuple[tuple[str, str], ...] = (
    ("image-based-tasks", "environment"),
    ("single-step-tasks", "single step"),
    ("separate-verifier-environment", "verifier environment"),
    ("per-task-agent-timeout", "per-task agent timeout"),
)

IDENTITY_ROWS: tuple[str, ...] = (
    IDENTIFIER_LABEL,
    SOURCE_REPOSITORY_LABEL,
    RELEASE_TAG_LABEL,
    RELEASE_COMMIT_LABEL,
)

# The label that manifest.json writes for each row, so a reader of the record recognizes the row.
ROW_LABELS: Mapping[str, str] = {
    IDENTIFIER_LABEL: "Dataset identifier",
    SOURCE_REPOSITORY_LABEL: "Source repository",
    RELEASE_TAG_LABEL: "Release tag",
    RELEASE_COMMIT_LABEL: "Release commit",
    SMOKE_TASKS_LABEL: "Smoke tasks",
    MCP_SERVERS_LABEL: "Tasks with declared MCP servers",
    SKILLS_DIRECTORY_LABEL: "Tasks with a declared skills directory",
    "environment": "Environment",
    "single step": "Single step",
    "verifier environment": "Verifier environment",
    "per-task agent timeout": "Per-task agent timeout",
}

# ADR 0008 §3 property 5: the dataset contains at least three CPU-only single-container tasks for
# the smoke job, and which tasks they are is dataset data.
MINIMUM_SMOKE_TASKS = 3

COMMIT_PATTERN = re.compile(r"[0-9a-f]{40}")

# A Markdown table separator row, such as | --- | --- |.
_SEPARATOR_CELL = re.compile(r":?[-=]+:?")
# \x60 is the backtick, written so that this module's own source holds no Markdown code span.
_CODE_SPAN = re.compile(r"\x60([^\x60]+)\x60")
_NUMBER = re.compile(r"([0-9][0-9,]*)\s*(?:s\b|seconds?\b)")


class DatasetRecordError(ValueError):
    """The dataset record cannot be read, or it does not have the rows ADR 0008 §4 shows."""


@dataclass(frozen=True)
class PropertyEvidence:
    """The evidence for one ADR 0008 §3 property, and where in the record it is written."""

    name: str
    label: str
    evidence: str | None
    source: str | None

    @property
    def shown(self) -> bool:
        return self.evidence is not None


@dataclass(frozen=True)
class DatasetRecord:
    """The dataset data that a recorded job's manifest and report carry (ADR 0008 §1 and §4)."""

    identifier: str
    source_repository: str
    release_tag: str
    release_commit: str
    smoke_tasks: tuple[str, ...]
    properties: tuple[PropertyEvidence, ...]
    mcp_server_tasks: tuple[str, ...]
    skills_tasks: tuple[str, ...]
    # The record's path as it was given, and the raw cell of every row this module reads.
    path: str
    rows: Mapping[str, str] = field(default_factory=dict)
    row_sources: Mapping[str, str] = field(default_factory=dict)

    @property
    def package_name(self) -> str:
        """The dataset name that Harbor's config.json records: org/name without the version."""
        return self.identifier.rpartition("@")[0]

    @property
    def admissibility_problems(self) -> tuple[str, ...]:
        """Why the dataset is not admissible under ADR 0008 §3, or nothing when it is."""
        problems = [
            f"{property_evidence.source or self.path} records no evidence for the "
            f"{property_evidence.label} property ({property_evidence.name})"
            for property_evidence in self.properties
            if not property_evidence.shown
        ]
        if len(self.smoke_tasks) < MINIMUM_SMOKE_TASKS:
            problems.append(
                f"{self.path} names {len(self.smoke_tasks)} smoke tasks, but ADR 0008 §3 requires "
                f"at least {MINIMUM_SMOKE_TASKS}"
            )
        return tuple(problems)

    def property(self, name: str) -> PropertyEvidence:
        for property_evidence in self.properties:
            if property_evidence.name == name:
                return property_evidence
        raise KeyError(name)

    def row_source(self, label: str) -> str | None:
        return self.row_sources.get(label)


def normalize_label(cell: str) -> str:
    """A row label reduced to the form this module compares: dataset identifier."""
    text = re.sub(r"[\x60*_]", "", cell)
    return re.sub(r"\s+", " ", text).strip().rstrip(":").lower()


def strip_code_span(cell: str) -> str:
    """A table cell with its surrounding Markdown code span removed, or the cell itself."""
    text = cell.strip()
    match = _CODE_SPAN.fullmatch(text)
    return match.group(1).strip() if match else re.sub(r"[\x60*]", "", text).strip()


def code_span_names(cell: str) -> tuple[str, ...]:
    """The task names of a cell, which the task-list rows write in Markdown code spans."""
    return tuple(name.strip() for name in _CODE_SPAN.findall(cell) if name.strip())


def parse_seconds(cell: str) -> int | None:
    """The seconds of a row such as 28,800 s, or None when the cell does not state one."""
    match = _NUMBER.search(cell.replace("\u00a0", " "))
    if match is None:
        return None
    return int(match.group(1).replace(",", ""))


def read_dataset_record(path: Path) -> DatasetRecord:
    """Reads the committed dataset record at path (ADR 0008 §1)."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise DatasetRecordError(
            f"{path} does not exist; give the dataset's committed record"
        ) from None
    except (OSError, UnicodeDecodeError) as exc:
        raise DatasetRecordError(f"cannot read {path}: {exc}") from exc
    return parse_dataset_record(text, source=str(path))


def parse_dataset_record(text: str, *, source: str) -> DatasetRecord:
    """Reads the record's Markdown tables. Every problem names source."""
    rows = parse_table_rows(text, source=source)

    def cell(label: str, *, required: bool) -> tuple[str | None, str | None]:
        found = rows.get(label)
        if found is None:
            if required:
                raise DatasetRecordError(
                    f"{source} has no {label!r} row; the record needs the rows of ADR 0008 §4"
                )
            return None, None
        value, line = found
        return strip_code_span(value), f"{source}:{line}"

    values: dict[str, str] = {}
    sources: dict[str, str] = {}
    for label in IDENTITY_ROWS:
        value, row_source = cell(label, required=True)
        values[label] = value
        sources[label] = row_source

    identifier = values[IDENTIFIER_LABEL]
    package, _, version = identifier.rpartition("@")
    if "/" not in package or version == "":
        raise DatasetRecordError(
            f"{source}: the dataset identifier must be a package dataset with a version, "
            f"org/name@version, found {identifier!r}"
        )
    release_commit = values[RELEASE_COMMIT_LABEL]
    if COMMIT_PATTERN.fullmatch(release_commit) is None:
        raise DatasetRecordError(
            f"{source}: the release commit must be 40 lowercase hex digits, "
            f"found {release_commit!r}"
        )

    smoke_tasks, _ = _task_list(rows, SMOKE_TASKS_LABEL, source)
    mcp_server_tasks, _ = _task_list(rows, MCP_SERVERS_LABEL, source)
    skills_tasks, _ = _task_list(rows, SKILLS_DIRECTORY_LABEL, source)

    properties: list[PropertyEvidence] = []
    raw_rows: dict[str, str] = {}
    for name, label in PROPERTY_ROWS:
        evidence, row_source = cell(label, required=False)
        properties.append(
            PropertyEvidence(
                name=name,
                label=ROW_LABELS.get(label, label),
                evidence=evidence or None,
                source=row_source if evidence else None,
            )
        )
        if label in rows:
            raw_rows[ROW_LABELS.get(label, label)] = rows[label][0]
    for label in IDENTITY_ROWS:
        if label in rows:
            raw_rows[ROW_LABELS.get(label, label)] = rows[label][0]
    for label in (SMOKE_TASKS_LABEL, MCP_SERVERS_LABEL, SKILLS_DIRECTORY_LABEL):
        if label in rows:
            raw_rows[ROW_LABELS.get(label, label)] = rows[label][0]

    return DatasetRecord(
        identifier=identifier,
        source_repository=values[SOURCE_REPOSITORY_LABEL],
        release_tag=values[RELEASE_TAG_LABEL],
        release_commit=release_commit,
        smoke_tasks=smoke_tasks,
        properties=tuple(properties),
        mcp_server_tasks=mcp_server_tasks,
        skills_tasks=skills_tasks,
        path=source,
        rows=raw_rows,
        row_sources=sources,
    )


def parse_table_rows(text: str, *, source: str) -> dict[str, tuple[str, int]]:
    """Every two-column table row of the Markdown text, keyed by its normalized label.

    Returns the raw second cell and the 1-based line number for each label. A label that appears
    twice is refused, because two rows about one value cannot both be the record.
    """
    rows: dict[str, tuple[str, int]] = {}
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if len(cells) != 2:
            continue
        label, value = cells
        if _SEPARATOR_CELL.fullmatch(label) or _SEPARATOR_CELL.fullmatch(value):
            continue
        key = normalize_label(label)
        if not key:
            continue
        if key in rows:
            raise DatasetRecordError(
                f"{source}: the row {label!r} appears at line {rows[key][1]} and again at line "
                f"{number}; a record holds one row per value"
            )
        rows[key] = (value, number)
    return rows


def _task_list(
    rows: Mapping[str, tuple[str, int]], label: str, source: str
) -> tuple[tuple[str, ...], str | None]:
    """The task names of an optional row, which writes none as 'none'."""
    found = rows.get(label)
    if found is None:
        return (), None
    value, line = found
    if re.sub(r"[\x60*_]", "", value).strip().lower() in ("", "none"):
        return (), f"{source}:{line}"
    tasks = code_span_names(value)
    if not tasks:
        raise DatasetRecordError(
            f"{source}:{line}: the {label!r} row must name its tasks in code spans, "
            f"found {value!r}"
        )
    return tasks, f"{source}:{line}"
