# The named task

This directory holds the named fixture task of
[ADR 0006](../../../../../docs/adr/0006-implementation-order-and-mvp-completion-checklist.md):
"add a failing test, then make it pass".

- `task.md` is the task file. Its entire content is the Coding Task objective.
- `repo/` is the fixture repository that the task runs against.

## Fixed artifacts

Both are fixed artifacts. The walking skeleton (Join 2), the end-to-end test (ADR 0006 §6 item 5)
and the TUI demo (§6 item 6) all run this task against this repository. The recorded provider
responses answer this exact task and these exact files. A change to either one changes what those
checks assert, and it makes the recordings stale. Change them only on purpose, in a change of their
own, and record the provider responses again.

## Rules

- A test copies `repo/` into a temporary directory and runs the Coding Agent on the copy. Nothing
  runs the agent on `repo/` in place.
- `repo/` holds no test file. The task has the agent add `src/slugify.test.ts`, and a test file
  here would also run in this repository's own `bun test`.
- `repo/AGENTS.md` is the Project Instructions of the fixture repository. It is not guidance for
  this repository.
- The task has two steps on purpose. The agent first adds the failing test and stops. With a
  verification command configured, that Candidate Completion fails Verification, and the feedback
  starts the second step.

## Recorded responses

`../google/named-task-read-only/` holds the three Google responses of one live run of the task, one
file for each Model Turn. The run used `gemini-3.5-flash-lite` on 2026-11-10 with `read` as the only
registered tool. The model reads `src/slugify.ts`, tries `src/slugify.test.ts`, which does not
exist, and then answers. `tests/headless.test.ts` and `tests/cli.test.ts` replay them.
