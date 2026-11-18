"""The launch contract of ADR 0005 §6, without Harbor."""

import re
import unittest
from pathlib import Path, PurePosixPath

from coding_agent_terminalbench.launch import (
    PROVIDER_KEY_VARIABLES,
    LaunchError,
    ModelChoice,
    build_command,
    check_agent_env,
    session_settled,
    split_model,
)

from tests.support import PROVIDER_KEY

REPO_ROOT = Path(__file__).resolve().parents[3]


class SplitModelTest(unittest.TestCase):
    def test_the_model_string_splits_at_its_first_slash(self) -> None:
        self.assertEqual(
            split_model("opencode/deepseek-v4.1-flash"),
            ModelChoice(provider="opencode", model="deepseek-v4.1-flash"),
        )
        self.assertEqual(
            split_model("openrouter/deepseek/deepseek-v4.1-flash-1017"),
            ModelChoice(provider="openrouter", model="deepseek/deepseek-v4.1-flash-1017"),
        )
        self.assertEqual(split_model("openrouter/a/b/c").model, "a/b/c")

    def test_a_model_string_without_both_parts_is_refused(self) -> None:
        for model_name in ("deepseek-v4.1-flash", "opencode/", "/deepseek-v4.1-flash", "/"):
            with self.subTest(model_name=model_name):
                with self.assertRaisesRegex(LaunchError, "is not <provider>/<model-id>"):
                    split_model(model_name)
        with self.assertRaisesRegex(LaunchError, "pass the model as -m"):
            split_model(None)

    def test_an_unknown_provider_is_refused(self) -> None:
        for provider in ("mistral", "OpenCode", "custom"):
            with self.subTest(provider=provider):
                with self.assertRaisesRegex(LaunchError, "is not one of anthropic, openrouter"):
                    split_model(f"{provider}/some-model")


class CheckAgentEnvTest(unittest.TestCase):
    def test_one_templated_key_of_the_provider_is_accepted(self) -> None:
        host = {"OPENCODE_API_KEY": PROVIDER_KEY}
        env = {**host, "IS_SANDBOX": "1"}
        self.assertEqual(check_agent_env(env, host), "OPENCODE_API_KEY")
        self.assertEqual(check_agent_env(env, host, "opencode"), "OPENCODE_API_KEY")
        # google reads either of two variables.
        gemini = {"GEMINI_API_KEY": PROVIDER_KEY}
        self.assertEqual(check_agent_env(gemini, gemini, "google"), "GEMINI_API_KEY")

    def test_no_key_is_refused(self) -> None:
        with self.assertRaisesRegex(LaunchError, "pass the provider key as --ae NAME="):
            check_agent_env({"IS_SANDBOX": "1"}, {})

    def test_two_keys_are_refused(self) -> None:
        both = {"OPENCODE_API_KEY": PROVIDER_KEY, "OPENAI_API_KEY": PROVIDER_KEY}
        with self.assertRaisesRegex(LaunchError, "OPENAI_API_KEY, OPENCODE_API_KEY; pass only"):
            check_agent_env(both, both, "opencode")
        google = {"GOOGLE_API_KEY": PROVIDER_KEY, "GEMINI_API_KEY": PROVIDER_KEY}
        with self.assertRaisesRegex(LaunchError, "GEMINI_API_KEY, GOOGLE_API_KEY"):
            check_agent_env(google, google, "google")

    def test_a_blank_key_is_refused(self) -> None:
        with self.assertRaisesRegex(LaunchError, "OPENCODE_API_KEY with a blank value"):
            check_agent_env({"OPENCODE_API_KEY": " "}, {"OPENCODE_API_KEY": " "})

    def test_a_value_that_differs_from_the_host_key_is_refused(self) -> None:
        for host_env in ({}, {"OPENCODE_API_KEY": "another-key"}):
            with self.subTest(host_env=host_env):
                with self.assertRaises(LaunchError) as raised:
                    check_agent_env({"OPENCODE_API_KEY": PROVIDER_KEY}, host_env)
                message = str(raised.exception)
                self.assertIn("pass the template OPENCODE_API_KEY='${OPENCODE_API_KEY}'", message)
                # A message never prints a value.
                self.assertNotIn(PROVIDER_KEY, message)
                self.assertNotIn("another-key", message)

    def test_a_literal_equal_to_the_host_key_cannot_be_told_from_a_template(self) -> None:
        # The check receives values that Harbor already resolved, so a literal with the host's
        # value is the same input as `${OPENCODE_API_KEY}`.
        same = {"OPENCODE_API_KEY": PROVIDER_KEY}
        self.assertEqual(check_agent_env(same, same, "opencode"), "OPENCODE_API_KEY")

    def test_the_key_of_another_provider_is_refused(self) -> None:
        opencode = {"OPENCODE_API_KEY": PROVIDER_KEY}
        with self.assertRaisesRegex(LaunchError, "'openrouter' reads OPENROUTER_API_KEY"):
            check_agent_env(opencode, opencode, "openrouter")


class BuildCommandTest(unittest.TestCase):
    def test_the_command_is_the_adr_command(self) -> None:
        self.assertEqual(
            build_command(
                ModelChoice(provider="opencode", model="deepseek-v4.1-flash"),
                PurePosixPath("/logs/agent"),
            ),
            "exec /installed-agent/coding-agent run --task-file /installed-agent/instruction.md "
            "--provider opencode --model deepseek-v4.1-flash --approval-policy auto-approve "
            "--profile terminalbench --output-dir /logs/agent/coding-agent",
        )

    def test_a_model_identifier_that_the_shell_would_split_is_quoted(self) -> None:
        command = build_command(
            ModelChoice(provider="opencode", model="a b"), PurePosixPath("/logs/agent")
        )
        self.assertIn("--model 'a b' ", command)


class SessionSettledTest(unittest.TestCase):
    def test_only_0_1_and_130_mean_a_settled_session(self) -> None:
        self.assertEqual([code for code in range(-15, 256) if session_settled(code)], [0, 1, 130])


class ProviderListTest(unittest.TestCase):
    def test_the_providers_are_the_ones_of_adr_0005(self) -> None:
        adr = (REPO_ROOT / "docs/adr/0005-terminalbench-evaluation-protocol.md").read_text("utf-8")
        line = re.search(r"--provider <provider>\s+required\s+(.+)", adr)
        assert line is not None
        self.assertEqual(list(PROVIDER_KEY_VARIABLES), line.group(1).strip().split(" | "))

    def test_the_key_variables_match_the_ai_package(self) -> None:
        source = (REPO_ROOT / "packages/ai/src/credentials.ts").read_text("utf-8")
        found = {
            provider: tuple(re.findall(r'"([A-Z_]+)"', names))
            for provider, names in re.findall(r"^\s+(\w+): Object\.freeze\(\[(.*?)\]", source, re.M)
        }
        self.assertEqual(found, dict(PROVIDER_KEY_VARIABLES))


if __name__ == "__main__":
    unittest.main()
