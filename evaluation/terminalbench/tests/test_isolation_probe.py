"""The probe that Tool Calls run in the task container (ADR 0005 §7 item 2), on a real `sh`.

The probe reads /proc, which only Linux has, so these tests run on Linux and are skipped elsewhere.
On another host, run them in a Linux container:

    docker run --rm -v "$PWD":/work:ro -w /work -e PYTHONPATH=src:. -e PYTHONDONTWRITEBYTECODE=1 \
        python:3.12-slim python -m unittest tests.test_isolation_probe
"""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from coding_agent_terminalbench.isolation_probe import build_probe_script, parse_probe_output
from coding_agent_terminalbench.isolation_report import (
    ANCESTORS,
    INHERITED_ENVIRONMENT,
    PROC_ENVIRON,
    PROC_MEM,
    Probe,
)

# The probe reads /proc/<pid>/environ and /proc/<pid>/mem, which exist only on Linux.
LINUX = sys.platform == "linux"

KEY = "sk-ant-isolation-test-0123456789abcdef0123456789abcdef"
AGENT_MARKER = "isolation-test-agent"


def run_probe(env: dict[str, str]) -> list[Probe]:
    """Writes the probe to a file and runs it under `sh`, as a Tool Call runs the uploaded file."""
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "probe.sh"
        script.write_text(build_probe_script(key=KEY, agent_marker=AGENT_MARKER))
        run_env = {"PATH": os.environ["PATH"], **env}
        result = subprocess.run(
            ["sh", str(script)], env=run_env, capture_output=True, text=True, check=False
        )
    return parse_probe_output(result.stdout)


def run_under_holder(env: dict[str, str]) -> list[Probe]:
    """Runs the probe as a child of a shell that stands in for an agent that is not hardened.

    The shell has `env`, which holds the key, and its command line holds the agent's marker. It
    runs the probe as a child, as Coding Agent holds a Tool Call's shell, so the key is in its
    /proc/<pid>/environ and in its memory, and the probe is its descendant.
    """
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "probe.sh"
        script.write_text(build_probe_script(key=KEY, agent_marker=AGENT_MARKER))
        # The second command keeps `sh -c` from replacing itself with the probe.
        holder = f"sh {script}; : {AGENT_MARKER}"
        result = subprocess.run(
            ["sh", "-c", holder],
            env={"PATH": os.environ["PATH"], **env},
            capture_output=True,
            text=True,
            check=False,
        )
    return parse_probe_output(result.stdout)


def run_under_hardened_holder(env: dict[str, str]) -> list[Probe]:
    """Like `run_under_holder`, but the holder is non-dumpable, as the Coding Agent marks itself.

    It calls prctl(PR_SET_DUMPABLE, 0), the call that ADR 0001 §8 rule 2 names, and then runs the
    probe as its child.
    """
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "probe.sh"
        script.write_text(build_probe_script(key=KEY, agent_marker=AGENT_MARKER))
        code = (
            "import ctypes, subprocess; "
            "ctypes.CDLL(None).prctl(4, 0, 0, 0, 0); "  # PR_SET_DUMPABLE is 4
            f"subprocess.run(['sh', {str(script)!r}]) # {AGENT_MARKER}"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            env={"PATH": os.environ["PATH"], **env},
            capture_output=True,
            text=True,
            check=False,
        )
    return parse_probe_output(result.stdout)


def yama_ptrace_scope() -> int | None:
    try:
        return int(Path("/proc/sys/kernel/yama/ptrace_scope").read_text())
    except (OSError, ValueError):
        return None


# Yama's ptrace_scope 1 or more denies /proc/<pid>/mem of an ancestor whatever its dumpability.
# Then a read that is denied shows nothing about the process, so these tests cannot hold.
MEM_NOT_BLOCKED_BY_YAMA = (yama_ptrace_scope() or 0) == 0


@unittest.skipUnless(LINUX, "the probe reads /proc, which only Linux has")
class InheritedEnvironmentTest(unittest.TestCase):
    def test_a_key_in_the_environment_of_the_probe_is_found(self) -> None:
        probes = run_probe({"ANTHROPIC_API_KEY": KEY})

        self.assertIn(Probe(path=INHERITED_ENVIRONMENT, outcome="read", found=True), probes)

    def test_the_value_is_found_in_a_variable_with_any_name(self) -> None:
        probes = run_probe({"RENAMED": KEY})

        self.assertIn(Probe(path=INHERITED_ENVIRONMENT, outcome="read", found=True), probes)

    def test_an_environment_without_the_key_does_not_find_it(self) -> None:
        # The probe holds the key in a shell variable that it does not export. If it did, every
        # run would find it in its own environment.
        probes = run_probe({"UNRELATED": "value"})

        self.assertIn(Probe(path=INHERITED_ENVIRONMENT, outcome="read", found=False), probes)


@unittest.skipUnless(LINUX, "the probe reads /proc, which only Linux has")
class ProcEnvironTest(unittest.TestCase):
    def test_the_environ_of_an_agent_that_is_not_hardened_is_read_and_holds_the_key(self) -> None:
        probes = run_under_holder({"ANTHROPIC_API_KEY": KEY})

        self.assertIn(Probe(path=PROC_ENVIRON, outcome="read", found=True), probes)

    def test_the_environ_of_a_non_dumpable_agent_is_denied_though_the_agent_is_still_found(
        self,
    ) -> None:
        # The probe finds the agent by its command line. A process that is not dumpable denies
        # /proc/<pid>/exe, so a probe that looked for the agent there would find none.
        probes = run_under_hardened_holder({"ANTHROPIC_API_KEY": KEY})

        self.assertIn(Probe(path=PROC_ENVIRON, outcome="EACCES", found=False), probes)


def run_under_command_line_holder() -> list[Probe]:
    """Runs the probe under a shell whose command line, not its environment, holds the key.

    This is the launcher that ADR 0001 §8 names after CDA-72: `sh -c 'ANTHROPIC_API_KEY=... cmd'`.
    Every process can read a command line, so the key is exposed whatever the shell's hardening.
    """
    with tempfile.TemporaryDirectory() as directory:
        script = Path(directory) / "probe.sh"
        script.write_text(build_probe_script(key=KEY, agent_marker=AGENT_MARKER))
        holder = f"ANTHROPIC_API_KEY={KEY} sh {script}; : {AGENT_MARKER}"
        result = subprocess.run(
            ["sh", "-c", holder],
            env={"PATH": os.environ["PATH"]},
            capture_output=True,
            text=True,
            check=False,
        )
    return parse_probe_output(result.stdout)


@unittest.skipUnless(LINUX, "the probe reads /proc, which only Linux has")
class AncestorsTest(unittest.TestCase):
    def test_an_ancestor_that_holds_the_key_in_its_environment_is_found(self) -> None:
        probes = run_under_holder({"ANTHROPIC_API_KEY": KEY})

        self.assertIn(Probe(path=ANCESTORS, outcome="read", found=True), probes)

    def test_an_ancestor_that_holds_the_key_in_its_command_line_is_found(self) -> None:
        probes = run_under_command_line_holder()

        self.assertIn(Probe(path=ANCESTORS, outcome="read", found=True), probes)

    def test_a_chain_without_the_key_finds_none(self) -> None:
        probes = run_under_holder({"UNRELATED": "value"})

        self.assertIn(Probe(path=ANCESTORS, outcome="read", found=False), probes)

    def test_an_ancestor_whose_environment_is_denied_is_passed_over(self) -> None:
        # A child is denied the environ of a non-dumpable ancestor too (ADR 0001 §8, CDA-72), so
        # the walk goes on to the next ancestor and still finishes.
        probes = run_under_hardened_holder({"ANTHROPIC_API_KEY": KEY})

        self.assertIn(Probe(path=ANCESTORS, outcome="read", found=False), probes)


@unittest.skipUnless(LINUX, "the probe reads /proc, which only Linux has")
class ProcMemTest(unittest.TestCase):
    @unittest.skipUnless(MEM_NOT_BLOCKED_BY_YAMA, "Yama denies /proc/<pid>/mem of an ancestor")
    def test_the_memory_of_an_agent_that_is_not_hardened_holds_the_key(self) -> None:
        probes = run_under_holder({"ANTHROPIC_API_KEY": KEY})

        self.assertIn(Probe(path=PROC_MEM, outcome="read", found=True), probes)

    def test_the_memory_of_a_non_dumpable_agent_is_denied(self) -> None:
        probes = run_under_hardened_holder({"ANTHROPIC_API_KEY": KEY})

        self.assertIn(Probe(path=PROC_MEM, outcome="EACCES", found=False), probes)


if __name__ == "__main__":
    unittest.main()
