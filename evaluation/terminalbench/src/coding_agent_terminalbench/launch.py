"""The launch contract of the adapter's run step (ADR 0005 §6).

This module decides the command, the provider key and the meaning of an exit code. It imports
nothing from Harbor, like `manifest.py`, so its tests need no container.

ADR 0001 §8 gives the `"auto-approve"` launch contract. Harbor runs the command through a shell
that holds the provider key in its environment. The command therefore `exec`s Coding Agent, so the
shell is replaced and does not stay alive with the key, and it has no pipeline, so no `tee` or
`grep` sibling holds the key either. Coding Agent's startup ancestor check refuses the run if an
ancestor still holds the key, so a launcher that failed to `exec` aborts the trial.
"""

import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath

from coding_agent_terminalbench.install import INSTALLED_EXECUTABLE

INSTRUCTION_PATH = "/installed-agent/instruction.md"

# Coding Agent writes run.json, events.jsonl and result.json here (ADR 0005 §4). Harbor downloads
# the environment's agent log directory after the run, so the files reach the trial directory.
OUTPUT_DIR_NAME = "coding-agent"

# ADR 0005 §3: 0, 1 and 130 mean that the Agent Session settled as succeeded, failed or cancelled.
# 2 and 70 mean that no Agent Session settled, and any other code is outside the contract.
SETTLED_EXIT_CODES = frozenset({0, 1, 130})

# The `--provider` values of ADR 0005 §3 and the variables that each one reads its key from.
# The names match PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER in packages/ai/src/credentials.ts.
PROVIDER_KEY_VARIABLES: Mapping[str, tuple[str, ...]] = {
    "anthropic": ("ANTHROPIC_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "google": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "xai": ("XAI_API_KEY",),
    "opencode": ("OPENCODE_API_KEY",),
}

KEY_VARIABLES = frozenset(name for names in PROVIDER_KEY_VARIABLES.values() for name in names)


class LaunchError(ValueError):
    """The job's `-m` or `--ae` values break the launch contract of ADR 0005 §6.

    It subclasses ValueError, so Harbor's preflight prints the message and stops the job.
    """


@dataclass(frozen=True)
class ModelChoice:
    """The `--provider` and `--model` values, split from Harbor's `-m` value."""

    provider: str
    model: str


def split_model(model_name: str | None) -> ModelChoice:
    """Split Harbor's `-m <provider>/<model-id>` at its first slash.

    The model identifier keeps any further slash, as in `openrouter/deepseek/deepseek-v4.1-flash`.
    """
    if model_name is None:
        raise LaunchError("pass the model as -m <provider>/<model-id>")
    provider, slash, model = model_name.partition("/")
    if not slash or not provider or not model:
        raise LaunchError(f"-m {model_name!r} is not <provider>/<model-id>")
    if provider not in PROVIDER_KEY_VARIABLES:
        raise LaunchError(
            f"the provider {provider!r} of -m {model_name!r} is not one of "
            f"{', '.join(PROVIDER_KEY_VARIABLES)}"
        )
    return ModelChoice(provider=provider, model=model)


def check_agent_env(
    agent_env: Mapping[str, str],
    host_env: Mapping[str, str],
    provider: str | None = None,
) -> str:
    """Return the one provider key variable that `--ae` passes, or raise LaunchError.

    `agent_env` holds the `--ae` values after Harbor resolved their templates, and `host_env` is
    the environment of the Harbor process. ADR 0005 §7 passes the key as the template
    `NAME='${NAME}'`, so its resolved value must equal the host's NAME. `provider` is None in
    preflight, which Harbor calls without the model.

    Harbor resolves the templates before it calls preflight or the constructor, so this check sees
    values only. It refuses a template of another host variable and a literal that differs from
    the host's NAME. A literal that equals the host's NAME passes, because its resolved value is the
    same as the template's. Harbor stores that literal in config.json as `${NAME}`.

    The messages name variables and never print a value.
    """
    found = sorted(name for name in agent_env if name in KEY_VARIABLES)
    if not found:
        raise LaunchError(
            "pass the provider key as --ae NAME='${NAME}', where NAME is one of "
            f"{', '.join(sorted(KEY_VARIABLES))}"
        )
    if len(found) > 1:
        raise LaunchError(
            f"--ae passes {', '.join(found)}; pass only the key of the -m provider, because ADR "
            "0005 §6 allows one credential in the agent's environment"
        )
    variable = found[0]
    value = agent_env[variable]
    if not value.strip():
        raise LaunchError(f"--ae passes {variable} with a blank value")
    if host_env.get(variable) != value:
        raise LaunchError(
            f"--ae passes {variable} with a value that differs from the host's {variable}; pass "
            f"the template {variable}='${{{variable}}}', so the agent uses the host's key"
        )
    if provider is not None and variable not in PROVIDER_KEY_VARIABLES[provider]:
        raise LaunchError(
            f"--ae passes {variable}, but the provider {provider!r} reads "
            f"{' or '.join(PROVIDER_KEY_VARIABLES[provider])}"
        )
    return variable


def build_command(choice: ModelChoice, environment_logs_dir: PurePosixPath) -> str:
    """The ADR 0005 §6 command: one `exec` of Coding Agent, with no pipeline."""
    argv = [
        INSTALLED_EXECUTABLE,
        "run",
        "--task-file",
        INSTRUCTION_PATH,
        "--provider",
        choice.provider,
        "--model",
        choice.model,
        "--approval-policy",
        "auto-approve",
        "--profile",
        "terminalbench",
        "--output-dir",
        str(environment_logs_dir / OUTPUT_DIR_NAME),
    ]
    # shlex.join quotes a model identifier only when the shell would split or expand it.
    return f"exec {shlex.join(argv)}"


def session_settled(return_code: int) -> bool:
    """Whether the exit code means that the Agent Session settled (ADR 0005 §3)."""
    return return_code in SETTLED_EXIT_CODES
