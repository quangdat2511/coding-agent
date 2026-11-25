# Demo: the interactive path with an Approval and a Cancellation

This is the demo of [ADR 0006](../../../docs/adr/0006-implementation-order-and-mvp-completion-checklist.md)
§6 item 6 (Join 3, CDA-87): the named fixture task runs through the Full-screen TUI against a live
provider, under the interactive `ask` policy. The person decides one Approval in the Approval
overlay and then cancels, and the cancelled Agent Run reports what it left in the workspace.

`interactive-path.cast` is the recording of one such run. "The demo works" is not a checkable
statement, so [`tests/demo-recording.test.ts`](../tests/demo-recording.test.ts) checks the
recording instead: it shows the output streaming, an Approval decided in the overlay, the
Cancellation requested and the Agent Run settling `cancelled` with its workspace report, and it
holds no credential.

A person runs this demo. It needs a live provider key and a real terminal, and neither a test nor
CI has them.

## What you need

- A Linux or macOS terminal, or WSL2 on Windows. The `coding-agent` bin entry does not start on
  Windows, and asciinema has no Windows build.
- A terminal of at least 100x32 that supports bracketed paste, which most do. The Prompt takes a
  pasted Coding Task as one piece, new lines included.
- [Bun](https://bun.sh) 1.3 or later, `git` 2.28 or later (`prepare-repo.sh` uses `git init -b`) and
  [asciinema](https://asciinema.org) 2 or 3.
- A key for the provider, in the environment of the shell that runs the demo. The committed
  recording uses `opencode` with `deepseek-v4.1-flash`, the evaluation provider and model of
  [ADR 0007](../../../docs/adr/0007-evaluation-provider-and-model.md), so it needs
  `OPENCODE_API_KEY`. Another provider works too: pass it and its model to `record.sh`, and report
  them on the ticket.

  This differs from [ADR 0006 §5](../../../docs/adr/0006-implementation-order-and-mvp-completion-checklist.md),
  which makes Google the daily driver and the provider "the demo" runs on, for cost. §6 item 6 asks
  only for "a live provider", and CDA-87 for "the provider and model used" to be recorded, so
  neither is broken. ADR 0007 chose this provider for the evaluation, not for demos. The demo uses
  it only because the person who ran it had its key. To spend nothing, run the demo again on Google
  with the same script.
- This repository's dependencies: `bun install` at the repository root.

## The run

Everything that the recording shows is fixed on purpose, so a reviewer can compare it with the
run.

| | |
| --- | --- |
| Provider and model | `opencode`, `deepseek-v4.1-flash` (the defaults of `record.sh`) |
| Approval Policy | `ask`. The interactive path takes no other |
| Run Limits | `default`: 30 Model Turns, 100 Tool Calls, 600,000 ms, 5,000 ms Cancellation Grace Period |
| Verification command | `bun test`, set by `record.sh` through `CODING_AGENT_VERIFICATION_COMMAND` |
| Repository state | the named task's repository, as a git repository with one commit, made by `prepare-repo.sh` |
| Coding Task | the whole of [`task.md`](../tests/fixtures/named-task/task.md), unchanged |

The task and its repository are fixed artifacts
([the fixture README](../tests/fixtures/named-task/README.md#fixed-artifacts)). Do not edit either to
make a run behave.

## Steps

### 1. Rehearse once without recording

`record.sh` never overwrites a recording, and the model does not always take the same path, so run
the demo by hand first and know what you will see.

```sh
# In this shell only, without echoing it or leaving it in the shell history.
read -rsp "OPENCODE_API_KEY: " OPENCODE_API_KEY && export OPENCODE_API_KEY; echo
repo=$(bash packages/coding-agent/demo/prepare-repo.sh)
CODING_AGENT_VERIFICATION_COMMAND="bun test" \
  bun --no-env-file --config=/dev/null packages/coding-agent/src/cli.ts \
  --provider opencode --model deepseek-v4.1-flash --repo-root "$repo"
```

Follow [step 3](#3-in-the-tui). When it works as described, end with two presses of Esc, and
remove the repository (`rm -rf "$repo"`). `record.sh` makes a new one.

### 2. Record

Resize the terminal to at least 100x32, then, from the repository root:

```sh
bash packages/coding-agent/demo/record.sh
```

It checks that the key is set and the tools exist, makes the demo repository, sets the Verification
command and starts `asciinema rec` on the Coding Agent. Keyboard input is not recorded, so what you
type is not in the file. When the Coding Agent exits it does three things before it keeps the
recording:

1. It searches the recording for the exact value of your key, and deletes the recording if the
   value is there.
2. It runs `tests/demo-recording.test.ts` against it, and deletes it if the recording does not show
   what the demo has to show.
3. It prints `git status` of the demo repository and the values to report on the ticket.

### 3. In the TUI

| # | You do | You should see |
| --- | --- | --- |
| 1 | Paste the content of `packages/coding-agent/tests/fixtures/named-task/task.md` into the Prompt, then press Enter. Open the file in another terminal to copy it, never in the one being recorded | The task appears in the transcript after `> `, and the Agent Run starts |
| 2 | Wait | `assistant [streaming]`: the answer streams in. The model first asks for a `bash` call that looks around the repository: `ls -la && cat package.json …; cat AGENTS.md` in the committed run, and `bun test` in the Google responses that the named-task test replays ([fixture README](../tests/fixtures/named-task/README.md#recorded-responses)) |
| 3 | Wait until the Approval overlay is drawn over the bottom of the transcript, and the footer reads `Esc/Ctrl+C cancel · y allow · n deny`. **Allow it:** press `y` | The overlay closes and the call goes from `[awaiting_approval]` to `[executing]` and `[succeeded]`, with its output under it. A quick command passes `[executing]` too fast to see |
| 4 | Wait | The model reads `src/slugify.ts` (a `read` needs no Approval), states its plan, then asks to `write` `src/slugify.test.ts`: the **second overlay** |
| 5 | **Cancel it:** press `Esc` while the second overlay is open | The overlay closes, the write never runs (`write src/slugify.test.ts [skipped, CANCELLED]`), `cancellation requested` appears, and the transcript ends with `run [cancelled]` and, under it, `workspace changed, partial changes possible` |
| 6 | Press `Esc` twice within one second | `Press Esc or Ctrl+C again within 1 second to quit.` after the first, and the Coding Agent exits 0 after the second. `record.sh` then takes over |

If the model takes another path, keep the rule and not the order: allow the first overlay, cancel at
the second one. The recording has to show an allowed call, because a cancelled Agent Run reports the
workspace as changed only after a mutating call has been allowed. If the model asks for no
second overlay, cancel at the next one, or while an allowed call is running. Do not keep a run that
shows `denied` in place of the allowed call, or one that settles `failed`.

Press `y` and `n` only once the overlay is on the screen: they count only after the keyboard has been
quiet for a moment, and `y` only while the summary is in view. A key pressed too early is dropped,
not queued, so press it again.

### 4. What the cancelled Agent Run reports

The last lines of the transcript are the Agent Result of the cancelled Agent Run:

```text
run [cancelled]
  workspace changed, partial changes possible
```

- `workspace changed` means a mutating Tool Call was allowed and started. `bash` counts as mutating,
  because the Coding Agent cannot tell what a command does, so an `ls` or a `bun test` alone makes
  it true. It says a change was possible, not that a file differs.
- `partial changes possible` means the Agent Run ended without succeeding after the workspace
  changed, so a half-finished change may be there.

Check it against the repository, outside the recording. The task was cancelled before the `write`,
so `git status --short` in the demo repository is expected to be empty, or to list only files that
an allowed command produced. That the report is cautious, and the repository is not changed, is the
expected outcome: the report promises no more than a possible change.

### 5. Commit and report

1. Play the recording once, with `asciinema play packages/coding-agent/demo/interactive-path.cast`.
   Nothing in it should be a surprise: no key, no path or file of yours that you would not publish.
2. `bun test packages/coding-agent/tests/demo-recording.test.ts` passes.
3. Commit the recording with the rest of the change. Add `interactive-path.cast` by name, not with
   `git add -A`.
4. Comment on CDA-87 with the values that `record.sh` printed: the provider and the model, the
   commit, and the versions of Bun and asciinema. A recording that shows a model does not say which
   model it was.

## The committed run

`interactive-path.cast` was recorded on 2026-11-20, with the Coding Agent at commit `1e93f8e`:

| | |
| --- | --- |
| Provider and model | `opencode`, `deepseek-v4.1-flash` |
| Host | WSL2 (Linux 6.18), Bun 1.4.5, asciinema 2.4.0, a 156x41 terminal |
| Approval allowed | `bash ls -la && cat package.json 2>/dev/null; cat AGENTS.md`, `[succeeded]` |
| Cancelled at | the Approval of `write src/slugify.test.ts`, which ended `[skipped, CANCELLED]` |
| Outcome | `session [cancelled]`, `workspace changed, partial changes possible` |
| Demo repository afterwards | `git status --short` empty: the cancelled write never ran |

The run and the checks around it exposed two defects of the Full-screen TUI. Both are filed rather
than fixed here, because they change `packages/tui` and not the demo, and neither touches an
Approval or a Cancellation:

- [CDA-119](https://datn-fit-hcmus.atlassian.net/browse/CDA-119): the terminal's answer to the
  TUI's kitty keyboard protocol query is echoed as the text `^[[?0u`, because Ink asks before it
  puts the terminal in raw mode. The first frame does not erase it: it only writes line breaks for
  the empty rows. The text stays on the first row of the screen until the Coding Task is drawn
  there, which is from 2.04 s to 32.63 s in the recording, about 30 s. Replaying the recording
  through `@xterm/headless` shows it.
- [CDA-120](https://datn-fit-hcmus.atlassian.net/browse/CDA-120): on Windows Terminal with WSL2
  the mouse wheel moves the Prompt cursor instead of scrolling the transcript, because the terminal
  sends each wheel step as an arrow key. PgUp and PgDn scroll. Selecting text and copying it works.
  This is the check that PR #65 left to the demo, together with copying and Shift+Enter, which
  both worked on that terminal. Shift+Enter is not shown to work elsewhere: a pseudo-terminal run
  on macOS suggests that when the terminal answers the query at once, Ink never turns the protocol
  on and Shift+Enter submits the Prompt. That is a lead for CDA-119, not a finding of this demo.

## When the run shows a defect

The ticket asks for each defect that the run exposes to be fixed here, or filed with a link from
CDA-87. `tests/demo-recording.test.ts` rejects a recording whose transcript shows one of the
messages in `DEFECT_SIGNS` of `tests/support/demo-recording.ts`, which are the Coding Agent saying
that something went wrong. Fix the defect or file it, then record again. A recording of a run that
hid a defect is worse than none.

Two things to look at on the first rehearsal, because the unit tests cannot reach them: whether the
pasted task reaches the Prompt as one piece (if Enter submits after its first line, the terminal
does not send bracketed paste, which is a defect of the demo's environment, not of the task) and
whether `Esc` cancels at once on that terminal (some terminals wait to tell `Esc` from the start of a
key sequence; `Ctrl+C` is the same key as far as the Coding Agent is concerned).

## Files

| File | Purpose |
| --- | --- |
| `README.md` | this script |
| `prepare-repo.sh` | makes the repository the demo starts from |
| `record.sh` | records the run, refuses a recording that holds the credential, and runs the check |
| `interactive-path.cast` | the committed recording, in asciinema's asciicast format |
