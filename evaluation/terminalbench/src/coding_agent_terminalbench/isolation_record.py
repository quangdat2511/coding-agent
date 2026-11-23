"""The Isolation Record: dated passing runs of the credential isolation test (ADR 0005 §7 item 3).

A job may start only after the isolation test has passed for its artifact on its backend, as a root
agent user and as a non-root one. The artifact manifest cannot hold that run, because the build
writes it before any test runs and `dist/` is not committed. The record is a committed file,
`evaluation/terminalbench/isolation/<artifact commit>.json`, that holds each passing run with the
date it was added. The test's own result has no timestamp, so equal runs give equal results.

    python -m coding_agent_terminalbench.isolation_record add --record <file> --result <file> \\
        [--adr-amendment <amendments>]
    python -m coding_agent_terminalbench.isolation_record check --record <file> \\
        --artifact-dir <dir> --dataset <name>@<version> --backend modal [--backend docker]

Only a passing run is recorded. A failed run is not written here: its cause goes to the Jira ticket
of the run (CDA-94 AC 4), and no credential-carrying job starts.
The amendment option is required when creating a record. An existing record keeps its amendments.
"""

import argparse
import json
import sys
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, NoReturn, TextIO

from coding_agent_terminalbench.manifest import ArtifactManifest, ArtifactManifestError, load_manifest

PROG = "isolation-record"

SCHEMA_VERSION = 1


class UsageError(ValueError):
    """The command line is wrong."""


class RecordError(ValueError):
    """The run cannot be recorded. The record is not changed."""


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise UsageError(message)


def utc_today() -> date:
    return datetime.now(UTC).date()


def add_run(
    record: dict[str, Any] | None,
    result: dict[str, Any],
    day: date,
    *,
    adr_amendment: str | None = None,
) -> dict[str, Any]:
    """Add a passing run and declare its artifact's amendments.

    A new record stores the supplied amendments. For an existing record, an explicit value must
    match its stored amendments. Bad arguments raise UsageError, and a refused run raises RecordError.
    """
    if adr_amendment is not None:
        adr_amendment = adr_amendment.strip()
        if not adr_amendment:
            raise UsageError("--adr-amendment must not be blank")
    elif record is None:
        raise UsageError("--adr-amendment is required when creating an Isolation Record")
    try:
        agent = result["codingAgent"]
        version, commit = agent["version"], agent["commit"]
        # `main` names the backend and the task, so a result without them is refused here.
        result["backend"], result["task"]  # noqa: B018
    except (KeyError, TypeError) as error:
        raise RecordError(f"the file is not an isolation test result: {error!r} is missing") from error
    if not result.get("passed"):
        raise RecordError(
            "the run did not pass, so it is not recorded; write its cause in the Jira ticket of "
            "the run, and start no job that carries a credential (ADR 0005 §7)"
        )
    if record is None:
        record = {
            "schemaVersion": SCHEMA_VERSION,
            "codingAgent": {"version": version, "commit": commit},
            "adrAmendment": adr_amendment,
            "runs": [],
        }
    elif not (
        isinstance(record, dict)
        and isinstance(record.get("codingAgent"), dict)
        and isinstance(record.get("runs"), list)
    ):
        # The record can be edited by hand, so its shape is checked before it is read.
        raise RecordError("the Isolation Record is malformed: it needs codingAgent and runs")
    elif record["codingAgent"] != {"version": version, "commit": commit}:
        raise RecordError(
            f"the record is for Coding Agent {record['codingAgent'].get('commit')}, and the run is "
            f"for {commit}; a record holds the runs of one commit"
        )
    elif adr_amendment is not None:
        recorded_amendment = record.get("adrAmendment")
        if not isinstance(recorded_amendment, str) or recorded_amendment.strip() != adr_amendment:
            raise RecordError(
                f"--adr-amendment {adr_amendment!r} does not match the existing Isolation Record "
                f"value {recorded_amendment!r}"
            )
    return {**record, "runs": [*record["runs"], {"date": day.isoformat(), "result": result}]}


def record_problems(
    record: dict[str, Any] | None,
    artifact: ArtifactManifest,
    dataset: str,
    backends: Sequence[str],
) -> list[str]:
    """Why a job on `backends` with `dataset` may not start with this artifact, or an empty list.

    This is the one check. record.py runs it before it writes a job's record, and the smoke job
    runs it before it starts (ADR 0005 §7 item 3): for each backend, a passing run as root and a
    passing run as a non-root agent user, of an executable that this artifact holds, on this
    dataset.
    """
    if record is None:
        return ["there is no Isolation Record; run the isolation test and add each passing run"]
    try:
        return _record_problems(record, artifact, dataset, backends)
    except (KeyError, TypeError, AttributeError) as error:
        # A hand-written record can have any shape. A job must not start on a record that cannot
        # be read, so the answer is a refusal and not a crash.
        return [f"the Isolation Record is malformed: {type(error).__name__} {error}"]


def _record_problems(
    record: dict[str, Any], artifact: ArtifactManifest, dataset: str, backends: Sequence[str]
) -> list[str]:
    problems: list[str] = []
    recorded = record["codingAgent"]["commit"]
    if recorded != artifact.commit:
        problems.append(
            f"the Isolation Record is for Coding Agent {recorded}, but the artifact is "
            f"{artifact.commit}; a rebuild means a new run of the isolation test"
        )
    held = {executable.sha256 for executable in artifact.executables}
    for backend in backends:
        runs = [
            entry["result"]
            for entry in record["runs"]
            if entry["result"]["backend"] == backend
            and entry["result"]["dataset"] == dataset
            # `add` writes only passing runs, but the file can be edited by hand.
            and entry["result"]["passed"] is True
        ]
        if not runs:
            problems.append(f"no passing run on {backend} for {dataset}")
            continue
        runs = [run for run in runs if run["executableSha256"] in held]
        if not runs:
            problems.append(
                f"no run on {backend} used an executable of this artifact: none of their "
                "SHA-256 values is in artifact-manifest.json"
            )
            continue
        if not any(run["user"]["uid"] == 0 for run in runs):
            problems.append(f"no passing run on {backend} as root")
        if not any(run["user"]["uid"] != 0 for run in runs):
            problems.append(f"no passing run on {backend} as a non-root agent user")
    return problems


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise UsageError(f"cannot read {path}: {error}") from error


def main(
    argv: Sequence[str],
    today: Callable[[], date] = utc_today,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
) -> int:
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr
    parser = _Parser(prog=PROG, add_help=False)
    commands = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    add = commands.add_parser("add")
    add.add_argument("--record", required=True, type=Path)
    add.add_argument("--result", required=True, type=Path)
    add.add_argument(
        "--adr-amendment",
        action="append",
        default=[],
        metavar="AMENDMENTS",
        help="ADR amendments implemented by the artifact (required when creating a record)",
    )
    check = commands.add_parser("check")
    check.add_argument("--record", required=True, type=Path)
    check.add_argument("--artifact-dir", required=True, type=Path)
    check.add_argument("--dataset", required=True)
    check.add_argument("--backend", required=True, action="append", dest="backends")
    try:
        arguments = parser.parse_args(list(argv))
        record = _read_json(arguments.record) if arguments.record.exists() else None
        if arguments.command == "check":
            problems = record_problems(
                record, load_manifest(arguments.artifact_dir), arguments.dataset, arguments.backends
            )
            for problem in problems:
                print(f"{PROG}: {problem}", file=err)
            if not problems:
                print("the Isolation Record covers every backend of the job", file=out)
            return 1 if problems else 0
        amendments = arguments.adr_amendment
        if len(amendments) > 1:
            raise UsageError("--adr-amendment may only be specified once")
        result = _read_json(arguments.result)
        updated = add_run(record, result, today(), adr_amendment=amendments[0] if amendments else None)
        arguments.record.parent.mkdir(parents=True, exist_ok=True)
        arguments.record.write_text(json.dumps(updated, indent=2) + "\n", encoding="utf-8")
    except (UsageError, ArtifactManifestError) as error:
        print(f"{PROG}: {error}", file=err)
        return 2
    except RecordError as error:
        print(f"{PROG}: {error}", file=err)
        return 1
    except OSError as error:
        print(f"{PROG}: cannot write {arguments.record}: {error}", file=err)
        return 2
    print(f"recorded the {result['backend']} run of {result['task']} in {arguments.record}", file=out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
