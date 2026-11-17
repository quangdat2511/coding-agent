# OpenCode Go fixtures

Where each file comes from. A reader should not have to guess which responses are real.

| File | Origin |
| --- | --- |
| `tool-call.txt`, `finish-reason-length.txt` | **Recorded** from the Go gateway with `examples/opencode-record-fixtures.ts`, unchanged. |
| `text-streaming.txt`, `usage-totals.txt` | **Recorded**, then edited: the answer text and the usage totals are set to the values the shared conformance cases assert (`"Hello, world!"`, 100 input and 42 output tokens). The rest is as recorded. |
| `tool-call-malformed-args.txt` | **Hand-written**, in the recorded chunk format. |
| `http-400-unknown-model.json` | **Recorded** on 2026-11-17: the answer to a request for a model Go does not serve, HTTP 400 with this body. |

The hand-written HTTP error responses (401, 429, 503) are in `packages/coding-agent/tests/fixtures/opencode/`
and are marked `.synthetic`.
