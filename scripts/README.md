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
export type { SessionEvent } from "../../agent-core/src/events.ts";
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
by the author, such as replies to review threads, and reviews by bots get no note.

GitHub makes a separate review with the commented verdict for each single comment and for each
reply in a review thread. The relay workflow waits two minutes before it relays such a review. If
the same reviewer comments again on the same pull request during that wait, the new review cancels
the wait and starts a new one. When the reviewer stops, one note reports the burst, such as
`đã comment review (11 lần)`. Comments less than three minutes apart count as one burst. An approval
or a change request is relayed at once. Its note also counts the comments that the reviewer made
just before it, such as `đã approve, kèm 3 lần comment`. The relay runs from the code of the pull
request, so a branch gets this wait only after you rebase it onto a `main` that has it.

When the author
pushes to a pull request that is ready for review, the note shows the new head commit. It mentions
the requested reviewers and everyone who already reviewed. A push to a draft gets no note. If the
pull request title changes, the post keeps its first title, because a webhook cannot rename a
thread.

Store these values on the Settings → Secrets and variables → Actions page of the repository:

| Name | Kind | Value |
|------|------|-------|
| `DISCORD_WEBHOOK_URL` | Secret | Webhook of `#ticket-forum`. If it is not set, the workflow skips. |
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
