#!/usr/bin/env bash
# Records the demo of the interactive path with asciinema, and refuses to keep a recording that
# holds the provider credential. Run it from a Linux or macOS terminal (WSL2 on Windows) that is at
# least 100x32, with the provider credential exported and nothing else to type in the shell.
#
# usage: bash packages/coding-agent/demo/record.sh [<provider> <model-id>]
# The defaults are the provider and model of the committed recording, the evaluation provider and
# model of ADR 0007: opencode, deepseek-v4.1-flash.
#
# It does not record keyboard input (no --stdin), so a key typed in the Prompt is not in the file.
# The recording is written beside this script as interactive-path.cast. It is kept only when the
# credential's value appears nowhere in it and tests/demo-recording.test.ts accepts it.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../../.." && pwd)
provider=${1:-opencode}
model=${2:-deepseek-v4.1-flash}
recording="$here/interactive-path.cast"

for tool in asciinema bun git; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "record: $tool is not installed" >&2
    exit 2
  fi
done

# The variables the provider's credential is read from, in lookup order, taken from
# PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER in packages/ai/src/credentials.ts so that a new provider
# needs no change here. The provider name goes in through the environment, not into the program.
if ! names=$(cd "$root" && PROVIDER="$provider" bun -e '
  import { PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER as byProvider } from "./packages/ai/src/credentials.ts";
  const names = (byProvider as Record<string, readonly string[]>)[process.env.PROVIDER ?? ""];
  if (names === undefined) process.exit(3);
  console.log(names.join(" "));
'); then
  echo "record: unknown provider \"$provider\"; the ones with a credential are in packages/ai/src/credentials.ts" >&2
  exit 2
fi
read -ra variables <<<"$names"

# The first variable that is set and not blank, as the Coding Agent reads it. Its value is never
# printed.
credential=""
for variable in "${variables[@]}"; do
  value=${!variable:-}
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ -n "$value" ]; then
    credential=$value
    break
  fi
done
if [ -z "$credential" ]; then
  echo "record: export ${variables[*]} before recording (the live provider is part of the demo)" >&2
  exit 2
fi

if [ "$(tput cols)" -lt 100 ] || [ "$(tput lines)" -lt 32 ]; then
  echo "record: resize the terminal to at least 100x32 (it is $(tput cols)x$(tput lines))" >&2
  exit 2
fi

if [ -e "$recording" ]; then
  echo "record: $recording exists; delete it first, to record again on purpose" >&2
  exit 2
fi

repo=$(bash "$here/prepare-repo.sh")

# A Verification command makes the Candidate Completion of the named task's first step fail, which
# is the loop the demo's task is written for. It is the person's choice, never the repository's.
export CODING_AGENT_VERIFICATION_COMMAND="bun test"

# Recorded to a file that is not the final one, so a recording that holds the credential is never
# left where `git add` would take it.
# The X's are the end of the template, the only place BSD mktemp (macOS) replaces them.
draft=$(mktemp "${TMPDIR:-/tmp}/interactive-path.XXXXXX")
trap 'rm -f "$draft"' EXIT

# asciinema runs --command through the shell, so each word is quoted for it: a path with a space
# stays one word.
command=$(printf '%q ' bun --no-env-file --config=/dev/null "$root/packages/coding-agent/src/cli.ts" \
  --provider "$provider" --model "$model" --repo-root "$repo")

echo "record: recording; follow packages/coding-agent/demo/README.md from step 3." >&2
asciinema rec --overwrite \
  --title "Coding Agent: the interactive path with an Approval and a Cancellation" \
  --command "$command" \
  "$draft"

# The exact value of the key, which the shapes in tests/support/demo-recording.ts cannot know.
if grep -qF -f <(printf '%s' "$credential") "$draft"; then
  echo "record: the recording holds the provider credential; it was deleted. Do not commit one." >&2
  exit 1
fi

mv "$draft" "$recording"
trap - EXIT

echo "record: the workspace after the run (git status of the demo repository):" >&2
git -C "$repo" status --short >&2

if ! (cd "$root" && bun test packages/coding-agent/tests/demo-recording.test.ts); then
  rm -f "$recording"
  echo "record: the recording does not show what the demo has to show; it was deleted." >&2
  echo "        Read the failure above and record again." >&2
  exit 1
fi

# What the comment on CDA-87 records (ADR 0006 §6 item 6: the provider and the model).
echo >&2
echo "record: for the comment on CDA-87:" >&2
echo "  provider: $provider" >&2
echo "  model:    $model" >&2
echo "  commit:   $(git -C "$root" rev-parse --short HEAD)" >&2
echo "  bun:      $(bun --version)" >&2
echo "  asciinema: $(asciinema --version 2>&1 | head -n 1)" >&2
echo "  host:     $(uname -sr)" >&2
echo "  policy:   ask (the interactive path)" >&2
