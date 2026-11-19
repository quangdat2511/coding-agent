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

`../google/named-task/` holds the eight Google responses of one live run of the task, one file for
each Model Turn. The run used `gemini-3.5-flash-lite` on 2026-11-19 with the four tools and
`bun test` as the verification command. The model runs `bun test`, which finds no test, reads
`src/slugify.ts`, writes `src/slugify.test.ts`, sees it fail with `bun test`, and stops. Verification
fails that Candidate Completion. The model then fixes `slugify` with `edit`, runs `bun test`, and
stops again, and Verification passes. `tests/named-task.test.ts` replays them: this is the
end-to-end test of ADR 0006 §6 item 5.

`../google/named-task-read-only/` holds the three Google responses of one live run of the task, one
file for each Model Turn. The run used `gemini-3.5-flash-lite` on 2026-11-10 with `read` as the only
registered tool. The model reads `src/slugify.ts`, tries `src/slugify.test.ts`, which does not
exist, and then answers. `tests/headless.test.ts` and `tests/cli.test.ts` replay them.

`../opencode/named-task-read-only/` holds two OpenCode Go responses for the same task. Unlike the
Google ones they are not a live run: they are written by hand in the gateway's Chat Completions
chunk format (a `read` of `src/slugify.ts`, then a text answer), because the Go credential was
not used to run the whole task. `tests/headless.test.ts` replays them.

`../google/finish-reason-max-tokens.txt` is not a recording of this task. It is a copy of the
`packages/ai` fixture of the same name: one Google response that ends at the output token limit, so
a run that replays it settles `failed`.
`tests/cli.test.ts` uses it for the exit code 1 smoke test.

`../google/credential-probe/` is not a recording either. Its two responses are hand-written in
Google's stream format: a `bash` call that prints whether `GOOGLE_API_KEY` is set, then a text
answer. `tests/cli.test.ts` replays them with a verification command that prints the same, to show
that neither child gets the credential.

## Recording the responses again

Record `../google/named-task/` again only after a deliberate change to `task.md` or `repo/`, or
when the replay fails because the Coding Agent no longer accepts the recorded Tool Calls, for
example after a tool's arguments change. Replay answers each request with the next file and never
compares the request with the recorded one. Recording takes one live run with your own Google key.
CI only replays the files.

`tests/support/record-provider.ts` is the recording counterpart of `replay-provider.ts`. Preloaded
into the Coding Agent, it sends each request to the provider and writes each successful response,
in order, to `turn-<n>.txt` in the directory that `CODING_AGENT_TEST_RECORD_DIR` names. It refuses
to write a response that contains a provider credential. On Linux or macOS, from the repository
root:

```sh
rm -rf packages/coding-agent/tests/fixtures/google/named-task /tmp/named-task-repo /tmp/named-task-out
cp -R packages/coding-agent/tests/fixtures/named-task/repo /tmp/named-task-repo
GOOGLE_API_KEY=... CODING_AGENT_VERIFICATION_COMMAND="bun test" \
  CODING_AGENT_TEST_RECORD_DIR=packages/coding-agent/tests/fixtures/google/named-task \
  bun --no-env-file --config=/dev/null \
  --preload ./packages/coding-agent/tests/support/record-provider.ts \
  packages/coding-agent/src/cli.ts run \
  --task-file packages/coding-agent/tests/fixtures/named-task/task.md \
  --provider google --model gemini-3.5-flash-lite --approval-policy auto-approve \
  --output-dir /tmp/named-task-out --repo-root /tmp/named-task-repo
```

Keep the recording only if the run exits 0 and `/tmp/named-task-out/events.jsonl` has a
`verification_completed` event with outcome `continue` before the one with outcome `succeeded`.
The model does not always stop after step 1. It can fix `slugify` as soon as it sees its own
`bun test` fail, and then the first Verification passes and the loop that the test asserts never
happens. One of four runs on 2026-11-19 took the loop. Run the whole block again until one does:
the `rm` and `cp` matter, because a failed run has changed the repository copy and left its own
turn files. Do not edit `task.md` or `repo/` to make a run take the loop: they are fixed artifacts
(see [Fixed artifacts](#fixed-artifacts)).

The test replays every `turn-<n>.txt` in the directory, in order, so no code changes. Update the
run described under [Recorded responses](#recorded-responses), and run
`bun test packages/coding-agent/tests/named-task.test.ts`.
