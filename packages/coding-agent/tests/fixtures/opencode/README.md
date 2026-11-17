# OpenCode Go fixtures

Where each file comes from. A reader should not have to guess which responses are real.

| File | Origin |
| --- | --- |
| `tool-call.txt` | Copy of the `packages/ai` recording from the Go gateway (see that directory's README). |
| `http-400-unknown-model.json` | **Recorded** from the Go gateway on 2026-11-17: the answer to a request for a model it does not serve, HTTP 400 with this body. The status is replayed by `replayRejection`. |
| `http-401.synthetic.json`, `http-429.synthetic.json`, `http-503.synthetic.json` | **Hand-written**, in the OpenAI error format that the recorded 400 confirms. The status is supplied by the test, not by Go. Go cannot be made to answer 401, 429 or 5xx on demand without spending allowance, and the status it returns when a window is exhausted is not known yet. |
| `named-task-read-only/turn-*.txt` | **Hand-written** in the gateway's Chat Completions chunk format. They are not a live run of the named task. |

`tests/headless.test.ts` replays the HTTP error files and asserts the status in `result.json` and in
`events.jsonl`. Replace the `.synthetic` files with recordings of the real answers when the smoke
job observes them (ADR 0007 §2).
