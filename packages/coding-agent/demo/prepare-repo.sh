#!/usr/bin/env bash
# Creates the repository that the demo of the interactive path starts from: a copy of the named
# fixture task's repository, as a git repository with one commit, so `git status` and `git diff`
# afterwards show exactly what the Coding Agent changed. Nothing runs the agent on the fixture in
# place (tests/fixtures/named-task/README.md).
#
# usage: bash prepare-repo.sh [<empty-or-new-directory>]
# Prints the directory on standard output; everything else goes to standard error.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fixture="$here/../tests/fixtures/named-task/repo"

if [ ! -d "$fixture" ]; then
  echo "prepare-repo: the fixture repository is missing: $fixture" >&2
  exit 2
fi

dir=${1:-$(mktemp -d "${TMPDIR:-/tmp}/coding-agent-demo.XXXXXX")}
if [ -d "$dir" ] && [ -n "$(ls -A "$dir")" ]; then
  echo "prepare-repo: $dir is not empty; name an empty or new directory" >&2
  exit 2
fi

mkdir -p "$dir"
cp -R "$fixture/." "$dir"
git -C "$dir" init -q -b main
git -C "$dir" add -A
# A fixed identity, so the commit does not depend on, or leak, the git configuration of the person.
git -C "$dir" -c user.name="Demo" -c user.email="demo@example.invalid" \
  commit -q -m "The start of the demo of the interactive path"

echo "prepare-repo: the demo repository is ready at $dir" >&2
echo "$dir"
