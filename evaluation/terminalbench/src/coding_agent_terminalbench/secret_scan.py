"""Scans an uncompressed Harbor job directory for credentials (ADR 0005 §8).

A recorded job's Harbor directory holds Coding Agent's logs, and a Tool Result records command
output, so a provider key that a task printed can reach the archive. Harbor's scrub replaces the
values passed through `--ae` with `[REDACTED]`, but only in files that look like UTF-8 text, and
the replacement erases the evidence that a key leaked. Publishing the archive therefore requires
this scan, which searches every regular file, including binary files, for:

- the exact byte value of every credential variable that the job used;
- `[REDACTED]`, which can be Harbor's replacement of a credential;
- the provider key prefixes that ADR 0005 §8 step 3 lists, which a truncated key still carries.

Every pattern is searched as UTF-8, UTF-16-LE and UTF-16-BE bytes, because a log or a binary file
can hold any of them in any of those encodings, and a pattern is searched once per distinct byte
sequence, so an ASCII occurrence is not reported twice.

A credential-value match can never be explained: the credential reached the logs, so the archive
is not published and the credential is revoked (ADR 0005 §8 step 4). A `[REDACTED]` or key-prefix
match is explainable by a review file, because a person has to show that it is not a credential,
or that the file is removed. The scan fails while any match is unexplained.

The scan reports each match by file and byte offset, and the review file consumes a match by the
same pair. For its own output the module never formats a credential value into a message or a
record: a credential match names its variable. A symbolic link to a directory raises an error
instead of being followed, so no file is silently left unscanned.
"""

import argparse
import json
import os
import stat
import sys
import tempfile
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

REDACTED_MARKER = "[REDACTED]"

# ADR 0005 §8 step 3 and ADR 0007: the key prefixes of the providers the recorded job may use. A
# truncated key still carries its prefix.
KEY_PREFIXES = ("sk-ant-", "sk-or-", "sk-proj-", "xai-", "AIza", "oc_sk_")

# How many bytes to read at a time, so a job directory of any size is scanned in bounded memory.
CHUNK_SIZE = 1 << 20

CREDENTIAL_KIND = "credential"
REDACTED_KIND = "redacted"
KEY_PREFIX_KIND = "key-prefix"

# A log holds a credential as UTF-8, or as UTF-16 when a Windows tool wrote it.
CREDENTIAL_ENCODINGS = ("utf-8", "utf-16-le", "utf-16-be")


class SecretScanError(ValueError):
    """A root, a file, the review file or a credential variable cannot be read or used."""


@dataclass(frozen=True)
class SecretMatch:
    """One occurrence of a scanned pattern, at the byte offset of its first byte."""

    path: str
    offset: int
    kind: str
    detail: str
    explanation: str | None = None


@dataclass(frozen=True)
class ScanReport:
    """The result of scanning the roots, with the review applied.

    `unexplained` holds the matches that no review entry explained, and `explanation_problems`
    the review entries that cannot explain a match. `passed` means the archive may be published:
    no match is unexplained and the review has no problem.
    """

    roots: tuple[str, ...]
    credential_variables: tuple[str, ...]
    files_scanned: int
    matches: tuple[SecretMatch, ...]
    unexplained: tuple[SecretMatch, ...]
    explanation_problems: tuple[str, ...]
    passed: bool


def read_credentials(names: Iterable[str], environment: Mapping[str, str]) -> dict[str, str]:
    """Reads the value of every named credential variable.

    A missing or blank value raises `SecretScanError` naming the variable and never prints the
    value, so a caller can report the failure without leaking the credential.
    """
    credentials: dict[str, str] = {}
    for name in names:
        value = environment.get(name)
        if value is None:
            raise SecretScanError(
                f"{name} is not set; pass the environment variable that held the credential"
            )
        if not value.strip():
            raise SecretScanError(
                f"{name} is blank; pass the environment variable that held the credential"
            )
        credentials[name] = value
    return credentials


def read_review(path: Path) -> dict[tuple[str, int], str]:
    """Reads the review file that explains `[REDACTED]` and key-prefix matches.

    The file is `{"reviewed": [{"file": ..., "offset": ..., "reason": ...}, ...]}`. The file and
    offset name a match that `report_text` printed, and the reason must be non-empty. An
    unreadable or malformed file, and an entry that repeats another's file and offset, raise
    `SecretScanError`.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise SecretScanError(
            f"{path} does not exist; give the JSON review file, or omit --review"
        ) from None
    except (OSError, UnicodeDecodeError) as exc:
        raise SecretScanError(f"cannot read {path}: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SecretScanError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise SecretScanError(f"{path}: the review must be a JSON object")
    entries = data.get("reviewed")
    if not isinstance(entries, list):
        raise SecretScanError(f'{path}: "reviewed" must be an array of entries')
    review: dict[tuple[str, int], str] = {}
    for index, entry in enumerate(entries):
        where = f"{path}: reviewed[{index}]"
        if not isinstance(entry, dict):
            raise SecretScanError(f"{where} must be an object")
        file = entry.get("file")
        if not isinstance(file, str) or file == "":
            raise SecretScanError(f"{where}.file must be a non-empty string")
        offset = entry.get("offset")
        if type(offset) is not int or offset < 0:
            raise SecretScanError(f"{where}.offset must be a non-negative integer")
        reason = entry.get("reason")
        if not isinstance(reason, str) or reason.strip() == "":
            raise SecretScanError(f"{where}.reason must be a non-empty string")
        key = (file, offset)
        if key in review:
            raise SecretScanError(
                f"{where} repeats the entry for {file} at offset {offset}; give each match one "
                "reason"
            )
        review[key] = reason
    return review


def scan_roots(
    roots: Sequence[str | Path],
    credentials: Mapping[str, str],
    review: Mapping[tuple[str, int], str] | None = None,
) -> ScanReport:
    """Scans every file under each root for the patterns of ADR 0005 §8.

    Each root is walked recursively and sorted, so the output is deterministic. Every regular
    file under a root is scanned and counted, binary files included, and a symlinked file is
    followed. A file is named as the root was given joined with the file's relative POSIX path,
    so the record tooling and the review file name the same string, and a match is keyed by that
    path and the byte offset of its first byte.

    A missing or unreadable root or file raises `SecretScanError`, and so does a symbolic link to a
    directory under a root: the walk does not follow directory links, so the scan refuses them
    instead of silently leaving their content unscanned.

    The review explains a match by its `(path, offset)`: only `[REDACTED]` and key-prefix
    matches can be explained, because a credential-value match means a credential reached the
    logs. A review entry for a credential-value match, and a review entry that names no found
    match, are explanation problems, and the report fails while it has an unexplained match or a
    problem.
    """
    review = {} if review is None else review
    root_names = tuple(Path(root).as_posix() for root in roots)
    patterns = _patterns(credentials)
    matches: list[SecretMatch] = []
    files_scanned = 0
    for display_root, root in zip(root_names, roots):
        root_path = Path(root)
        try:
            status = root_path.stat()
        except FileNotFoundError:
            raise SecretScanError(
                f"{display_root} does not exist; give an uncompressed job directory"
            ) from None
        except OSError as exc:
            raise SecretScanError(f"cannot read {display_root}: {exc}") from exc
        if stat.S_ISDIR(status.st_mode):
            candidates = _files_under(root_path, display_root)
        elif stat.S_ISREG(status.st_mode):
            candidates = [(display_root, root_path)]
        else:
            raise SecretScanError(f"{display_root} is not a directory or a regular file")
        for display_path, path in candidates:
            files_scanned += 1
            matches.extend(_search_file(path, display_path, patterns))
    ordered = sorted(
        matches, key=lambda match: (match.path, match.offset, match.kind, match.detail)
    )
    reviewed, problems = _apply_review(ordered, review)
    unexplained = tuple(match for match in reviewed if match.explanation is None)
    return ScanReport(
        roots=root_names,
        credential_variables=tuple(sorted(credentials)),
        files_scanned=files_scanned,
        matches=reviewed,
        unexplained=unexplained,
        explanation_problems=problems,
        passed=not unexplained and not problems,
    )


def scan_record(report: ScanReport) -> dict[str, Any]:
    """The scan's part of manifest.json (ADR 0005 §8 step 5).

    A credential match names its variable, never the value, and the record never formats a
    credential value.
    """
    explained = sorted(
        (
            {"file": match.path, "offset": match.offset, "reason": match.explanation}
            for match in report.matches
            if match.explanation is not None
        ),
        key=lambda entry: (entry["file"], entry["offset"]),
    )
    return {
        "roots": list(report.roots),
        "patterns": {
            "credentialVariables": sorted(report.credential_variables),
            "prefixes": list(KEY_PREFIXES),
            "redactedMarker": REDACTED_MARKER,
        },
        "files": report.files_scanned,
        "result": "passed" if report.passed else "failed",
        "explained": explained,
        "unexplained": len(report.unexplained),
    }


def report_text(report: ScanReport) -> str:
    """The scan's lines for the person who reviews the archive (ADR 0005 §8).

    Each match is one line that names its file, byte offset, kind and detail, and whether a review
    explained it; a credential match names its variable, never the value. The summary names the
    file count and the result, and the explanation problems follow it.
    """
    lines = [_match_line(match) for match in report.matches]
    result = "passed" if report.passed else "failed"
    files = _plural(report.files_scanned, "file", "files")
    roots = _plural(len(report.roots), "root", "roots")
    unexplained = _plural(len(report.unexplained), "unexplained match", "unexplained matches")
    problems = _plural(
        len(report.explanation_problems), "explanation problem", "explanation problems"
    )
    lines.append(f"Scanned {files} under {roots}: {result} ({unexplained}, {problems})")
    if report.explanation_problems:
        lines.append("Explanation problems:")
        lines.extend(f"- {problem}" for problem in report.explanation_problems)
    return "\n".join(lines)


def main(
    argv: Sequence[str] | None = None,
    *,
    environment: Mapping[str, str] | None = None,
) -> int:
    """The `python -m coding_agent_terminalbench.secret_scan` command.

    It returns 0 when the scan passes, 1 when a match is unexplained or a review entry is a
    problem, and 2 when the command line, a credential variable, a root, a file or the review file
    cannot be used. The report is printed to stdout, and `--json` writes `scan_record` through a
    temporary file so a failed write leaves no partial file.
    """
    parser = argparse.ArgumentParser(
        prog="python -m coding_agent_terminalbench.secret_scan",
        description=(
            "Scan uncompressed Harbor job directories for credentials (ADR 0005 §8). The scan "
            "fails until a review explains every [REDACTED] and key-prefix match or the match "
            "is removed."
        ),
    )
    parser.add_argument(
        "roots",
        nargs="+",
        type=Path,
        metavar="PATH",
        help="an uncompressed job directory or file; every file under a directory is scanned",
    )
    parser.add_argument(
        "--credential",
        action="append",
        default=[],
        metavar="NAME",
        help="the name of an environment variable that held a credential the job used; repeat it",
    )
    parser.add_argument(
        "--review",
        type=Path,
        help="the JSON review file that explains [REDACTED] and key-prefix matches",
    )
    parser.add_argument(
        "--json",
        type=Path,
        dest="json_path",
        help="write the manifest.json scan record to this file",
    )
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        # argparse exits for an unusable command line; the contract returns 2 instead.
        return exc.code if isinstance(exc.code, int) else 2
    environment = os.environ if environment is None else environment
    try:
        credentials = read_credentials(args.credential, environment)
        review = read_review(args.review) if args.review is not None else {}
        report = scan_roots(args.roots, credentials, review)
    except SecretScanError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(report_text(report))
    if args.json_path is not None:
        try:
            _write_record(args.json_path, scan_record(report))
        except SecretScanError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    return 0 if report.passed else 1


def _patterns(credentials: Mapping[str, str]) -> tuple[tuple[str, str, bytes], ...]:
    """The `(kind, detail, bytes)` patterns to search for, in a deterministic order."""
    patterns: list[tuple[str, str, bytes]] = []
    for variable in sorted(credentials):
        patterns.extend(_encoded_patterns(CREDENTIAL_KIND, variable, credentials[variable]))
    patterns.extend(_encoded_patterns(REDACTED_KIND, REDACTED_MARKER, REDACTED_MARKER))
    for prefix in KEY_PREFIXES:
        patterns.extend(_encoded_patterns(KEY_PREFIX_KIND, prefix, prefix))
    return tuple(patterns)


def _encoded_patterns(kind: str, detail: str, text: str) -> Iterator[tuple[str, str, bytes]]:
    """One pattern per distinct encoding of a text, so one occurrence is reported once."""
    seen: set[bytes] = set()
    for encoding in CREDENTIAL_ENCODINGS:
        encoded = text.encode(encoding)
        if encoded in seen:
            continue
        seen.add(encoded)
        yield (kind, detail, encoded)


def _search_file(
    path: Path, display: str, patterns: Sequence[tuple[str, str, bytes]]
) -> list[SecretMatch]:
    """Finds every pattern in a file in `CHUNK_SIZE` reads, each occurrence reported once.

    The read keeps an overlap of one byte less than the longest pattern, so a pattern that spans
    two chunks is still found. A match that lies entirely in the overlap was reported by the
    previous read, so it is skipped here.
    """
    overlap = max((len(pattern) for _, _, pattern in patterns), default=1) - 1
    matches: list[SecretMatch] = []
    try:
        with path.open("rb") as file:
            position = 0
            tail = b""
            while True:
                chunk = file.read(CHUNK_SIZE)
                if not chunk:
                    break
                buffer = tail + chunk
                for kind, detail, pattern in patterns:
                    start = 0
                    while True:
                        index = buffer.find(pattern, start)
                        if index < 0:
                            break
                        start = index + len(pattern)
                        if index + len(pattern) <= len(tail):
                            # The whole match was in the previous read's overlap.
                            continue
                        matches.append(
                            SecretMatch(
                                path=display,
                                offset=position - len(tail) + index,
                                kind=kind,
                                detail=detail,
                            )
                        )
                position += len(chunk)
                tail = buffer[-overlap:] if overlap else b""
    except OSError as exc:
        raise SecretScanError(f"cannot read {display}: {exc}") from exc
    return matches


def _files_under(root: Path, display_root: str) -> list[tuple[str, Path]]:
    """Every regular file under `root`, with its reported path, sorted by that path.

    A symbolic link to a directory raises `SecretScanError`, because os.walk does not follow it
    and the scan must not pass over content unseen.
    """
    files: list[tuple[str, Path]] = []
    for directory, dirnames, filenames in os.walk(root, onerror=_walk_failed):
        dirnames.sort()
        relative_dir = os.path.relpath(directory, root)
        for name in sorted(dirnames):
            if (Path(directory) / name).is_symlink():
                relative = (
                    name if relative_dir == os.curdir else Path(relative_dir, name).as_posix()
                )
                display = _display_path(display_root, relative)
                raise SecretScanError(
                    f"{display} is a symbolic link to a directory; the scan does not follow "
                    "directory links, so replace it with the directory or remove it"
                )
        for name in sorted(filenames):
            path = Path(directory) / name
            relative = name if relative_dir == os.curdir else Path(relative_dir, name).as_posix()
            display = _display_path(display_root, relative)
            if not path.is_file():
                if path.is_symlink():
                    raise SecretScanError(
                        f"{display} is a symbolic link whose target is not a readable file"
                    )
                # A FIFO or a device is not a regular file, and reading it could block forever.
                continue
            files.append((display, path))
    files.sort(key=lambda entry: entry[0])
    return files


def _walk_failed(error: OSError) -> None:
    """Turns a directory that os.walk cannot read into a `SecretScanError`."""
    name = error.filename if error.filename is not None else "a directory"
    raise SecretScanError(f"cannot read {name}: {error.strerror or error}")


def _display_path(display_root: str, relative: str) -> str:
    """The reported path: the root as given joined with the file's relative POSIX path."""
    if relative in ("", os.curdir):
        return display_root
    return f"{display_root.rstrip('/')}/{relative}"


def _apply_review(
    matches: Sequence[SecretMatch], review: Mapping[tuple[str, int], str]
) -> tuple[tuple[SecretMatch, ...], tuple[str, ...]]:
    """Explains the matches the review names, and reports the entries that cannot explain one."""
    positions: dict[tuple[str, int], list[int]] = {}
    for index, match in enumerate(matches):
        positions.setdefault((match.path, match.offset), []).append(index)
    reviewed = list(matches)
    problems: list[str] = []
    for path, offset in sorted(review):
        reason = review[(path, offset)]
        indexes = positions.get((path, offset))
        if indexes is None:
            problems.append(
                f"{path} at offset {offset} is reviewed, but the scan found no match there; "
                "remove the review entry"
            )
            continue
        for index in indexes:
            match = reviewed[index]
            if match.kind == CREDENTIAL_KIND:
                problems.append(
                    f"{path} at offset {offset} holds the credential {match.detail}; a "
                    "credential-value match can never be explained, so remove the file from the "
                    "archive and revoke the credential"
                )
            else:
                reviewed[index] = replace(match, explanation=reason)
    return tuple(reviewed), tuple(problems)


def _match_line(match: SecretMatch) -> str:
    """One scanned match: its file and offset, then the kind and detail.

    A credential match's detail is the variable that held the value, never the value itself.
    """
    line = f"{match.path}:{match.offset}: {match.kind} {match.detail}"
    if match.explanation is None:
        return f"{line} (unexplained)"
    return f"{line} (explained: {' '.join(match.explanation.split())})"


def _plural(count: int, singular: str, plural: str) -> str:
    return f"{count} {singular if count == 1 else plural}"


def _write_record(path: Path, record: Mapping[str, Any]) -> None:
    """Writes the record through a temporary file, so a failed write leaves no partial file."""
    text = json.dumps(record, indent=2, allow_nan=False) + "\n"
    temporary: str | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as file:
            temporary = file.name
            file.write(text)
        os.replace(temporary, path)
    except OSError as exc:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
        raise SecretScanError(f"cannot write {path}: {exc}") from exc


if __name__ == "__main__":
    sys.exit(main())
