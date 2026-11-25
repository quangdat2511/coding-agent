# Repository checks

## Import boundary check

Run `bun run check:import-boundaries` from the repository root. Lefthook runs it on staged `.ts`
and `.tsx` files; CI runs it with no arguments, which checks every workspace package.

The check reads each `.ts` and `.tsx` file whose nearest `package.json` is a workspace package,
skipping `node_modules` and `dist`, and finds the specifiers of `from` clauses, side-effect imports,
dynamic `import()`, and `require()`. It fails on a `@/`, `@tests/`, or `@examples/` path alias, on a
relative specifier that resolves outside the file's own package, and on a given path that does not
exist. A nested directory with its own `package.json` is not a workspace package, so its files are
not checked. The scan is textual: a matching specifier inside a comment or string also fails, and a
template literal with a `${}` substitution is not checked.

### CDA-99 acceptance demonstration

Temporarily add `packages/tools/src/probe.ts`:

```ts
export type { RunEvent } from "../../agent-core/src/events.ts";
```

`bun run check:import-boundaries` exits 1 and reports:

```text
packages/tools/src/probe.ts:1: "../../agent-core/src/events.ts" resolves outside packages/tools; import that package by name
```

Staging the file makes the Lefthook pre-commit hook fail the same way. Delete the file afterwards.

## Runtime sibling import check

Run `bun run check:runtime-imports` from the repository root. The CI workflow runs this command
in its own job on pull requests and pushes to `main`.

The check bundles the `ai`, `agent-core`, `tools`, and `tui` entry points with
`bun build --target bun --packages external --external '@coding-agent/*'`, then parses the emitted
JavaScript for sibling imports, re-exports, dynamic imports, and requires (including Bun's
`__require` helper). `--packages external` leaves third-party imports unbundled, because bundling
them fails on optional peers that are not installed, such as Ink's `react-devtools-core`; relative
imports still resolve to the package's own files, so a sibling import in any of them is caught,
such as a runtime `@coding-agent/ai` import in `packages/tui/src/render.tsx`.
The `coding-agent` composition root is intentionally excluded. Type-only imports disappear
from the bundles. Build or parse errors also fail the command; temporary output is removed.

### CDA-38 acceptance demonstration

Temporarily replace `packages/agent-core/src/index.ts` with:

```ts
import { ProviderDirectory } from "@coding-agent/ai";
export const probe = ProviderDirectory;
```

`bun run check:runtime-imports` exits 1 and reports:

```text
@coding-agent/agent-core: forbidden runtime import: import { ProviderDirectory } from "@coding-agent/ai";
```

Replace it with the same symbol used only as a type:

```ts
import type { ProviderDirectory } from "@coding-agent/ai";
export type Probe = typeof ProviderDirectory;
```

The command exits 0. Restore the entry point after the demonstration.

Also verified: `require("@coding-agent/ai")`, `import("@coding-agent/ai")`, and
`export * from "@coding-agent/ai"` fail when retained in the bundle; exporting the plain string
`"@coding-agent/ai"` passes. These checks inspect reachable emitted code, not unused source imports
or computed module specifiers.

## Tools child-process launch check

`bun run ci:check` also enforces CDA-68's shared launch path through Biome. The `tools` package
cannot import `bun`, `bun:ffi`, `node:child_process`/`child_process`, `node:cluster`/`cluster`, or
`node:worker_threads`/`worker_threads`, including literal dynamic imports. Production
files under `packages/tools/src/`, except `child-process.ts`, cannot reference the `Bun` global or
reach it through `globalThis`, `global`, `self`, or `require`. The broader global restriction
blocks these direct aliases of the raw spawning API; ordinary filesystem work uses the existing
`node:fs` APIs. `bun run check:import-boundaries` additionally rejects access to `getBuiltinModule`
and `import.meta.require` in those production files, including literal computed properties and
local aliases. It parses transpiled source, so comments and strings are not treated as loader
access. Both Lefthook and CI run this check; `child-process.ts` is the single trusted exception.
Tests can still use `bun:test` and Bun's test-fixture APIs.

The composition root passes AI's complete credential-name set to `createChildProcessLauncher`.
Future bash and Verification adapters receive that configured launcher and use `launch` rather
than spawning directly. Its interface has no environment override, and it copies and filters the
current parent environment for every child. The one permitted launch module is responsible for
passing that filtered environment to Bun; review and process-level tests cover that module.
These lint rules constrain ordinary source code; they are not a sandbox for arbitrary generated
JavaScript or native code.

### CDA-68 acceptance demonstration

Temporarily add `packages/tools/src/probe.ts`:

```ts
import { spawn } from "node:child_process";

export const nodeChild = () => spawn("echo", ["probe"]);
export const bunChild = () => Bun.spawn(["echo", "probe"]);
```

`bunx biome check packages/tools/src/probe.ts` exits 1 with `noRestrictedImports` and
`noRestrictedGlobals` errors. The same rules run in the existing CI lint step and staged-file
pre-commit check. Remove the probe afterwards; `child-process.ts` itself passes the lint check.

## Evaluation artifact build

A recorded TerminalBench job runs a standalone executable, not a source checkout
([ADR 0005 §2](../docs/adr/0005-terminalbench-evaluation-protocol.md)).
`scripts/build-artifact.ts` builds that executable for both Linux targets and writes the manifest
that identifies the build.

To build the artifact for a recorded job:

1. Check out the commit on `main` that the job evaluates. The build does not check the branch, so
   this step is yours.
2. Make sure that `git status` shows no changes and no untracked files.
3. Make sure that Bun is the version in `.bun-version`.
4. Run `bun ci --ignore-scripts`, so that `node_modules` matches `bun.lock`. The dirty check
   does not look at `node_modules`, so do not build after `bun install`, `bun link`, or an edit
   there.
5. Make sure that no provider credential, such as `ANTHROPIC_API_KEY`, is in the environment or
   in the repository's `.env`. On a host that runs one of the executables, the build refuses
   either one.
6. Run the build from the repository root on Linux or macOS:

   ```sh
   bun run build:artifact
   ```

7. Give the Harbor adapter the directory `dist/artifact`.

The build writes three files into `dist/artifact`, or into the directory that `--out-dir <dir>`
names. A relative `--out-dir` resolves against the working directory. An `--out-dir` in the
repository must be a path that git ignores.

| File | Content |
| --- | --- |
| `coding-agent-linux-x64` | the executable for the `bun-linux-x64-baseline` target, which needs no AVX2 |
| `coding-agent-linux-arm64` | the executable for the `bun-linux-arm64` target |
| `artifact-manifest.json` | the manifest that the adapter checks before each trial |

Each executable needs glibc 2.17 or newer and no other runtime. Both builds use
`--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`. A `.env` or `bunfig.toml` file
in the working directory of a task therefore cannot configure the agent. The build sets the commit
with `--define CODING_AGENT_COMMIT`, so `run.json` and `--version` both name it.

`artifact-manifest.json` has this shape:

```json
{
  "schemaVersion": 1,
  "codingAgent": { "version": "0.0.1", "commit": "<40-character commit, or that commit and -dirty>" },
  "dirty": false,
  "bunVersion": "1.3.14",
  "executables": [
    { "file": "coding-agent-linux-x64", "target": "bun-linux-x64-baseline", "sha256": "<hex>" },
    { "file": "coding-agent-linux-arm64", "target": "bun-linux-arm64", "sha256": "<hex>" }
  ]
}
```

`coding-agent --version` prints one line, `coding-agent <version> <commit>`, with the values of
`codingAgent` in the manifest. A run from source has no commit and prints
`coding-agent <version> (no commit)`.

The build stops with exit code 1 in these cases:

- The working tree has changes or untracked files. The message lists them.
- The running Bun is not the version in `.bun-version`.
- `--out-dir` is in the repository, and git does not ignore it.
- A provider credential is in the environment of the build, in the repository's `.env`, or in
  the environment of a process that started the build, and the host can run one of the
  executables.
- `packages/coding-agent/package.json` has no `coding-agent` bin entry. The build compiles that
  entry.
- `bun build` fails for a target.
- The executable that this host can run fails a check, or a check runs longer than 30 seconds.

Linux on x86-64 or on arm64 can run one of the executables. On such a host, the build runs that
executable in a temporary directory, next to a `bunfig.toml` with a preload that writes
`preloaded` to standard error. It does two checks:

- `--version` must print exactly the line that the manifest file implies. Standard error must
  stay empty, so the preload's `preloaded` line must not appear.
- `run` must exit 2 with an error that names `ANTHROPIC_API_KEY`, next to a `.env` that sets
  `ANTHROPIC_API_KEY`. Exit 2 means that no Agent Run opened. Standard error must not contain
  `preloaded`.

On macOS, and on a musl Linux host such as Alpine, the build cannot run either executable, so it
prints that `--version` was not checked.
The CI job `Evaluation artifact` runs the build on `ubuntu-24.04`, so CI checks the x64 executable
on every pull request. CI does not check the arm64 executable, because this private repository has
no arm64 Linux runner. To check it, run the build on an arm64 Linux host or in an arm64 container.

The CI build only checks that the build works. On a pull request, CI builds the merge commit
`refs/pull/<n>/merge`, which is not a commit on `main`. Do not give the manifest or the
executables of a pull request run to a recorded job.

For a local test of uncommitted work, pass `--allow-dirty`. The build then records
`"dirty": true`, and the commit in the manifest and in `--version` ends in `-dirty`. Do not give a
dirty artifact to a recorded job.

Bun 1.3.14 on Windows cannot cross-compile these targets. It stops with
`Failed to extract executable for 'bun-linux-x64-baseline-v1.3.14'`. On Windows, run the build in
WSL or in a Linux container. Run `bun test scripts/tests/build-artifact.test.ts` for the unit
tests.

## Discord PR posts

The `Discord PR Post` workflow runs `scripts/notify-discord.ts` on pull requests into `main`. When a
pull request opens ready for review, or a draft becomes ready, the workflow creates a post in the
`#ticket-forum` Discord channel. The post has the title of the pull request. It links the pull
request and mentions the author and the requested reviewers.

Nothing is written on the pull request. The workflow uploads the thread ID of the post as an
artifact named `discord-thread-pr-<number>` and keeps it for 90 days. Later events find the post
through this artifact and add a note to it. These events are a reviewer requested later, a return
to draft, a new ready for review, a reopen, a merge, and a close. If the pull request becomes ready
again, the note lists the reviewers. A reviewer requested within two minutes of the post, and
already mentioned in it, gets no second mention.

Posts created before the artifact keep the thread ID in a hidden marker on a `github-actions[bot]`
comment. If a pull request has no artifact, the script reads that marker. If a pull request stays
open longer than 90 days, it loses its artifact, and later events no longer reach its post.

Two more events add a note to the post. When a reviewer submits a review, the note names the
verdict (approved, changes requested, or commented) and mentions the pull request author. Reviews
by the author, such as replies to review threads, and reviews by bots get no note. The relay
workflow skips them, so they use no Actions minutes.

GitHub makes a separate review with the commented verdict for each single comment and for each
reply in a review thread. The relay workflow waits two minutes before it relays such a review. If
the same reviewer comments again on the same pull request during that wait, the new review cancels
the wait and starts a new one. When the reviewer stops, one note reports the burst, such as
`đã comment review (2 lần)`. Comments less than three minutes apart count as one burst.

A review that only replies in existing threads, for example "fixed" before a resolve, counts as a
thread reply and not as a new comment. The note then reads `đã comment review, trả lời 10 thread`,
or `đã trả lời 10 thread` when there is no new comment. To tell the two apart, the script reads
the comments of each review in the burst that has no body.

An approval or a change request is relayed at once. Its note also counts the comments that the
reviewer made just before it, such as `đã approve, kèm 3 lần comment`. The relay runs from the
code of the pull request, so a branch gets this wait only after you rebase it onto a `main` that
has it.

When the author
pushes to a pull request that is ready for review, the note shows the new head commit. It mentions
the requested reviewers and everyone who already reviewed. A push to a draft gets no note. If the
pull request title changes, the post keeps its first title, because a webhook cannot rename a
thread.

After the note for a merge or a close, the script closes the post. Discord calls this "archive":
the post leaves the list of open posts in the forum. A webhook cannot archive a thread, so this
step uses a Discord bot through `DISCORD_BOT_TOKEN`. The post is not locked. If a note comes later,
for example after a reopen, Discord opens the post again. If the secret is not set, the post stays
open. If Discord refuses the request, the post stays open and the run shows a warning. The warning
gives the HTTP status and the Discord error code, such as `403, code 50013 (Missing Permissions)`.
Code 50013 means that the bot lacks a permission. Code 50001 means that the bot cannot see the
channel, for example because the token belongs to a bot that is not on the server. After the
warning, the log names the bot that the token belongs to and the servers that the bot is in. It
also tells whether the bot can read the post. The token itself never appears in the log.

To get the token, create an application on the Discord Developer Portal and add a bot to it.
Invite the bot to the server with the View Channels and Manage Threads permissions on
`#ticket-forum`. Then copy the bot token into the `DISCORD_BOT_TOKEN` secret.

Store these values on the Settings → Secrets and variables → Actions page of the repository:

| Name | Kind | Value |
|------|------|-------|
| `DISCORD_WEBHOOK_URL` | Secret | Webhook of `#ticket-forum`. If it is not set, the workflow skips. |
| `DISCORD_BOT_TOKEN` | Secret | Optional token of a Discord bot with the Manage Threads permission. The script uses it to close the post after a merge or a close. If it is not set, the post stays open. |
| `DISCORD_USER_IDS` | Variable | JSON object from GitHub login to Discord user ID, such as `{"quangdat2511": "123456789012345678"}`. An unmapped login appears as plain `@login` text. |
| `DISCORD_FORUM_TAG_ID` | Variable | Optional ID of the forum tag for new posts. If Discord rejects the tag, for example after the tag was deleted, the post has no tag and the run shows a warning. |

The workflow uses `pull_request_target`, so it runs the script from `main`. A change to the script
or the workflow takes effect only after it merges. Reviews come through a second workflow,
`Discord PR Review Relay`. GitHub runs `pull_request_review` with the code of the pull request, so
the relay gets no secrets. It uploads only the pull request number and the review ID. The
`Discord PR Post` workflow then starts from `main` through `workflow_run` and reads the review back
from GitHub.

The posting step uses `continue-on-error`. A Discord failure or a wrong secret or variable leaves
the checks of the pull request green and shows the error in the job log. Run
`bun test scripts/tests/notify-discord.test.ts` for the unit tests.

## Managed binaries manifest and CI setup

`grep` and `find` run pinned versions of `rg` (ripgrep) and `fd`. The source of truth for those
pinned builds is `packages/tools/src/managed-tools.json`, which records `schemaVersion`, and for
each tool its `version`, `repo`, `tagPrefix`, `minimumVersion`, and all six supported
platform/architecture assets (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
`win32-arm64`, `win32-x64`) with their exact `asset` filename, `bytes`, and `sha256` digest.

### Updating pinned versions (`scripts/update-managed-tools.ts`)

`scripts/update-managed-tools.ts` is the only code in the repository that calls the GitHub API
(`/releases/latest`). It runs by hand in a pull request, never in CI or during a normal test run.

To bump the pinned `fd` and `rg` versions:

1. Create a branch from the latest `main`.
2. Run the update script from the repository root (optionally with `GITHUB_TOKEN` or `GH_TOKEN`
   set to avoid unauthenticated API rate limits):

   ```sh
   bun run update:managed-tools
   ```

   The script fetches `/releases/latest` for `sharkdp/fd` and `BurntSushi/ripgrep`, validates that
   the tag matches `tagPrefix`, checks that the version is at or above `minimumVersion`, verifies
   that all six required assets are present with valid byte sizes and 64-hex `sha256:` digests,
   and rewrites `packages/tools/src/managed-tools.json`. If any of the six targets is missing or
   has no SHA-256 digest, the script exits 1 without rewriting the manifest.
3. Inspect `git diff packages/tools/src/managed-tools.json` to confirm the new versions and asset
   hashes.
4. Run the offline checks and tests:

   ```sh
   bun run check
   bun run typecheck
   bun test packages/tools/tests/managed-tools-manifest.test.ts scripts/tests/update-managed-tools.test.ts scripts/tests/setup-ci-managed-tools.test.ts
   ```

5. Open a pull request. The Ubuntu and Windows CI jobs will download the newly pinned binaries,
   verify their byte sizes and SHA-256 hashes against the updated manifest, and run the full test
   suite with `CODING_AGENT_OFFLINE=1`. For a platform-specific check on macOS, trigger the `CI`
   workflow manually on the branch.

### CI setup (`scripts/setup-ci-managed-tools.ts`)

The `Test (ubuntu-24.04)`, `Test (windows-2025)`, and `Test (macos-26)` jobs in
`.github/workflows/ci.yml` run `bun run scripts/setup-ci-managed-tools.ts` before the test suite.
It reads `packages/tools/src/managed-tools.json`, downloads only the host's pinned `fd` and `rg`
release archives from `github.com/<repo>/releases/download/...`, bounds the streamed download by
`bytes` and verifies `sha256` before extraction, extracts into a temporary directory, checks that
`<binary> --version` matches the exact pinned version, and appends the binary directory to
`GITHUB_PATH`.

After setup completes, the test suite itself runs with `CODING_AGENT_OFFLINE=1` so no test calls
GitHub during a normal run. GitHub API calls (`/releases/latest`) happen only when running
`scripts/update-managed-tools.ts` manually in a pull request, never in CI or during tests. Run
`bun test scripts/tests/setup-ci-managed-tools.test.ts` for the offline unit tests.
