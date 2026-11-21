"""The pass or fail decision of the credential isolation test (ADR 0001 §8, ADR 0005 §7).

The test starts the evaluated artifact in a task container and has Tool Calls try the four paths
that ADR 0005 §7 item 2 names. This module holds what it decides from what the probes saw. It
imports nothing from Harbor and nothing that needs Docker, so its tests run anywhere.
"""

import json
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

# The four paths of ADR 0005 §7 item 2. The names are the `path` values in the result.
INHERITED_ENVIRONMENT = "inherited-environment"
PROC_ENVIRON = "proc-environ"
PROC_MEM = "proc-mem"
ANCESTORS = "ancestors"
PATHS = (INHERITED_ENVIRONMENT, PROC_ENVIRON, PROC_MEM, ANCESTORS)

# The outcomes that show a read that Linux allowed ("read") or denied (EACCES, EPERM). Any other,
# such as the probe not finding Coding Agent, leaves the path untested.
CONCLUSIVE_OUTCOMES = frozenset({"read", "EACCES", "EPERM"})


@dataclass(frozen=True)
class Probe:
    """What a Tool Call saw on one path: how the access ended, and whether it found the key."""

    path: str
    outcome: str
    found: bool


@dataclass(frozen=True)
class Control:
    """What the same probe saw on a process that holds the key and is not hardened."""

    path: str
    found: bool


@dataclass(frozen=True)
class LauncherResult:
    """The run in which a launcher keeps its shell alive instead of replacing it (ADR 0001 §8).

    `message_matched` says that the first line of the output names an ancestor that holds the key.
    The output is standard error and then standard output, because Harbor's Docker environment
    sends one into the other. `server_requests` is how many requests the fake server got from that
    run.
    """

    exit_code: int
    message_matched: bool
    server_requests: int


@dataclass(frozen=True)
class ServerObservations:
    """What the fake model server saw during the run in which the launcher does `exec`."""

    tool_results_received: int
    expected_tool_results: int
    key_matched: bool


class FailureCode(StrEnum):
    """Why the test failed. Each value is the `code` of a failure in the result."""

    KEY_FOUND = "KEY_FOUND"
    CONTROL_FAILED = "CONTROL_FAILED"
    PATH_NOT_TESTED = "PATH_NOT_TESTED"
    MEM_NOT_DEMONSTRABLE = "MEM_NOT_DEMONSTRABLE"
    LAUNCHER_NOT_REJECTED = "LAUNCHER_NOT_REJECTED"
    TOOL_RESULTS_MISSING = "TOOL_RESULTS_MISSING"
    KEY_NOT_DELIVERED = "KEY_NOT_DELIVERED"


@dataclass(frozen=True)
class Failure:
    code: FailureCode
    message: str


@dataclass(frozen=True)
class Observations:
    """Everything the run saw, which the decision reads.

    `yama_ptrace_scope` is the value in the container, or None when Yama is not loaded.
    """

    probes: list[Probe]
    controls: list[Control]
    yama_ptrace_scope: int | None
    launcher: LauncherResult
    server: ServerObservations


@dataclass(frozen=True)
class Report:
    passed: bool
    failures: list[Failure] = field(default_factory=list)


def evaluate(observed: Observations) -> Report:
    probes, controls = observed.probes, observed.controls
    yama_ptrace_scope = observed.yama_ptrace_scope
    launcher, server = observed.launcher, observed.server
    # A path that no probe reported on shows nothing, so it cannot count as denied. The same holds
    # for a probe that ended in a way that Linux does not give for a read that was allowed or
    # denied.
    by_path = {probe.path: probe for probe in probes}
    failures: list[Failure] = []
    for path in PATHS:
        probe = by_path.get(path)
        if probe is None:
            failures.append(
                Failure(code=FailureCode.PATH_NOT_TESTED, message=f"no probe result for {path}")
            )
        elif not probe.found and probe.outcome not in CONCLUSIVE_OUTCOMES:
            failures.append(
                Failure(
                    code=FailureCode.PATH_NOT_TESTED,
                    message=(
                        f"the probe on {path} ended with {probe.outcome}, "
                        "which does not show that the read was denied"
                    ),
                )
            )
    failures += [
        Failure(
            code=FailureCode.KEY_FOUND, message=f"a Tool Call found the key through {probe.path}"
        )
        for probe in probes
        if probe.found
    ]
    yama_denies = yama_ptrace_scope is not None and yama_ptrace_scope >= 1
    # Every path needs a control result, as it needs a probe result. A control run that printed
    # nothing would otherwise leave every denied probe unchecked.
    controls_by_path = {control.path: control for control in controls}
    for path in PATHS:
        control = controls_by_path.get(path)
        if control is None:
            failures.append(
                Failure(code=FailureCode.CONTROL_FAILED, message=f"no control result for {path}")
            )
            continue
        if control.found:
            continue
        if control.path == PROC_MEM and yama_denies:
            # Yama denies /proc/<pid>/mem of an ancestor whatever its dumpability, so a denied
            # probe there would show nothing about the artifact.
            failures.append(
                Failure(
                    code=FailureCode.MEM_NOT_DEMONSTRABLE,
                    message=(
                        f"{PROC_MEM} cannot be shown: ptrace_scope is {yama_ptrace_scope}, which "
                        "denies the read even on a process that is not hardened"
                    ),
                )
            )
        else:
            # A probe that cannot read a key that is there proves nothing when it then finds none.
            failures.append(
                Failure(
                    code=FailureCode.CONTROL_FAILED,
                    message=(
                        f"the probe did not find the key on a process that holds it, on "
                        f"{control.path}"
                    ),
                )
            )
    if server.tool_results_received < server.expected_tool_results:
        count = f"{server.tool_results_received} of {server.expected_tool_results}"
        hint = (
            "; the artifact may not follow ANTHROPIC_BASE_URL, so no Tool Call ran"
            if server.tool_results_received == 0
            else ""
        )
        failures.append(
            Failure(
                code=FailureCode.TOOL_RESULTS_MISSING,
                message=f"the model server got {count} Tool Results{hint}",
            )
        )
    if not server.key_matched:
        failures.append(
            Failure(
                code=FailureCode.KEY_NOT_DELIVERED,
                message=(
                    "a request to the model server did not carry the disposable key in x-api-key"
                ),
            )
        )
    # Exit 2 alone does not show that the startup check refused the launcher: every configuration
    # error exits with 2. The message names the cause, and no request shows no session opened.
    if launcher.exit_code != 2:
        failures.append(_launcher_failure(f"it ended with exit code {launcher.exit_code}, not 2"))
    elif not launcher.message_matched:
        failures.append(
            _launcher_failure("exit code 2 came without the message that names an ancestor's key")
        )
    elif launcher.server_requests != 0:
        failures.append(
            _launcher_failure(
                f"the model server got {launcher.server_requests} requests, so a session opened"
            )
        )
    return Report(passed=not failures, failures=failures)


@dataclass(frozen=True)
class RunContext:
    """What the result says about the run itself, so a person can attach it to a manifest."""

    coding_agent_version: str
    coding_agent_commit: str
    executable_sha256: str
    dataset: str
    task: str
    backend: str
    uid: int
    user_name: str


SCHEMA_VERSION = 1


def result_document(context: RunContext, observed: Observations) -> dict[str, Any]:
    """The JSON that the test prints. Its keys follow the artifact manifest's camelCase."""
    report = evaluate(observed)
    probes, controls = observed.probes, observed.controls
    launcher, server = observed.launcher, observed.server
    return {
        "schemaVersion": SCHEMA_VERSION,
        "passed": report.passed,
        "failures": [{"code": f.code, "message": f.message} for f in report.failures],
        "codingAgent": {
            "version": context.coding_agent_version,
            "commit": context.coding_agent_commit,
        },
        "executableSha256": context.executable_sha256,
        "dataset": context.dataset,
        "task": context.task,
        "backend": context.backend,
        "user": {"uid": context.uid, "name": context.user_name},
        "yamaPtraceScope": observed.yama_ptrace_scope,
        "probes": [{"path": p.path, "outcome": p.outcome, "found": p.found} for p in probes],
        "controls": [{"path": c.path, "found": c.found} for c in controls],
        "launcherRejected": {
            "exitCode": launcher.exit_code,
            "messageMatched": launcher.message_matched,
            "serverRequests": launcher.server_requests,
        },
        "toolResultsReceived": server.tool_results_received,
    }


class SecretInResultError(ValueError):
    """The result holds the disposable key. The message never names the value."""


def render_result(document: dict[str, Any], secret: str) -> str:
    """The text that the test prints on standard output, or SecretInResultError.

    The result goes into files that people attach to a manifest, so it must not hold the key even
    though the key is disposable.
    """
    text = json.dumps(document, indent=2) + "\n"
    if secret in text:
        raise SecretInResultError("the result holds the disposable key, so it is not printed")
    return text


def _launcher_failure(reason: str) -> Failure:
    return Failure(
        code=FailureCode.LAUNCHER_NOT_REJECTED,
        message=(
            "the launcher that keeps its shell was not rejected by the startup check: " + reason
        ),
    )
