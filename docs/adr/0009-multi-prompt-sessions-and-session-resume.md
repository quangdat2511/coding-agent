# Multi-Prompt Sessions and Session Resume

Status: accepted

Date: 2026-11-24

## Context

Stage 1 of Group 1 adds items 1 and 5 of the Pi feature gap: a conversation of many prompts, and
saving and resuming it. Until now the interactive path ran each Coding Task as an Agent Run that
started from an empty transcript, refused a submission while an Agent Run was active
([ADR 0004](./0004-package-apis-and-dependency-direction.md) §6), and kept nothing after Quit.

The stage 1 proposal of 2026-11-22 settled three points.
[CDA-147](https://datn-fit-hcmus.atlassian.net/browse/CDA-147) renamed Agent Session to Agent Run,
which frees Session for the conversation the person sees. Each prompt runs a new Agent Run seeded
with the Session's Transcript. Run Limits and Verification apply per Agent Run.

[Wayfinder: Stage 1 Group 1](https://datn-fit-hcmus.atlassian.net/browse/CDA-132) settled the rest.
Five research tickets came first:
[CDA-133](https://datn-fit-hcmus.atlassian.net/browse/CDA-133) on Pi's steering and follow-up
queues ([research](../research/pi-steering-and-follow-up.md)),
[CDA-134](https://datn-fit-hcmus.atlassian.net/browse/CDA-134) on Pi's session files
([research](../research/pi-session-files.md)),
[CDA-135](https://datn-fit-hcmus.atlassian.net/browse/CDA-135) on Claude Code's `--worktree`
([research](../research/claude-code-worktree.md)),
[CDA-136](https://datn-fit-hcmus.atlassian.net/browse/CDA-136) on lock files under Bun
([research](../research/cross-platform-lock-files.md)), and
[CDA-137](https://datn-fit-hcmus.atlassian.net/browse/CDA-137) on the key chords that reach the TUI
([research](../research/tui-key-chords.md)). The decisions followed:
[CDA-138](https://datn-fit-hcmus.atlassian.net/browse/CDA-138) (the Transcript an Agent Run starts
from), [CDA-139](https://datn-fit-hcmus.atlassian.net/browse/CDA-139) (Steers),
[CDA-140](https://datn-fit-hcmus.atlassian.net/browse/CDA-140) (the Prompt Queue),
[CDA-141](https://datn-fit-hcmus.atlassian.net/browse/CDA-141) (the Session file),
[CDA-142](https://datn-fit-hcmus.atlassian.net/browse/CDA-142) (the Session lock),
[CDA-143](https://datn-fit-hcmus.atlassian.net/browse/CDA-143) (Worktrees),
[CDA-144](https://datn-fit-hcmus.atlassian.net/browse/CDA-144) (the TUI prototype),
[CDA-145](https://datn-fit-hcmus.atlassian.net/browse/CDA-145) (the Session Controller and its
Actions) and [CDA-162](https://datn-fit-hcmus.atlassian.net/browse/CDA-162) (the command line). Each
resolution comment holds its evidence and its comparison with Pi, Claude Code, Codex, Gemini CLI and
OpenCode.

This record gathers what those decisions fix in Coding Agent and the Terminal UI. What they change
in Agent Core is recorded as amendments to ADRs 0002 to 0004, and ADR 0001 gains one (see
Consequences). Headless `coding-agent run` is unchanged: one Coding Task, no Prompt Queue, no
Session file, no Session lock and no Worktree
([ADR 0005](./0005-terminalbench-evaluation-protocol.md) §3).

## Decision

### 1. Sessions and Agent Runs

- A Session belongs to Coding Agent. It holds an id (a UUIDv4 with no kind prefix), its Repository
  Root, its Transcript, its system prompt, its Session name, the model its next Agent Run uses
  (§9.5) and its Prompt Queue. Agent Core knows nothing of it.
- Each Coding Task opens a new Agent Run, configured with the Session's Transcript as `transcript`,
  the Prompt Queue as `steers` and Coding Agent's `TranscriptWording` as `wording` (ADR 0002 §8,
  ADR 0004 §10). A Session has at most one active Agent Run, so nothing else writes its Transcript.
  After `run_settled`, the Session's Transcript becomes the settled run's `snapshot().transcript`;
  a run refused at open, or never started, leaves it unchanged.
- An Agent Run has exactly one Coding Task: the prompt that opens it, which is the first prompt or a
  Follow-up. A Steer belongs to the running Coding Task. A Follow-up is a new Coding Task, even when
  it says "continue".
- Run Limits and Verification apply to each Agent Run. Nothing limits a whole Session.
- The system prompt, Project Instructions included, is built when a Session is created and reused
  by every Agent Run in it (§4.7, ADR 0003 §5).

### 2. Model-facing wording

Coding Agent words every message it adds for the model, so changing a word never touches Agent
Core. Its `TranscriptWording` implementation, which Agent Core calls, and its crash patch (§4.8) use
the texts below. The system prompt's sentences about Sessions are in ADR 0003 §5.

**Closing Tool Results**, each with `isError: true`:

| Tool Call | Content |
| --- | --- |
| skipped after a cancellation | Not run: the person cancelled the Coding Task before this call started. |
| skipped after a failure or a Run Limit | Not run: the Coding Task ended before this call started. |
| stopped while running, with no result of its own within the Cancellation Grace Period | Stopped: the Coding Task ended while this call was running, and the call returned no result. It may have changed the repository partly. |
| still open when Coding Agent stopped unexpectedly (§4.8) | Not completed: Coding Agent stopped unexpectedly; this call may or may not have run and may have changed the repository partly. |

**Outcome Notes** are user messages of the form `<task_outcome status="…">…</task_outcome>`. Their
status and content are escaped as the `path` attribute of the Project Instructions wrapper is
(ADR 0003 §1), so quoted text cannot close the tag. A successful run gets none.

| Outcome | `status` | Content |
| --- | --- | --- |
| cancelled | `cancelled` | The person cancelled this Coding Task before it finished. Do not continue it unless they ask. Tools that were stopped may have changed the repository partly. |
| `LIMIT_EXCEEDED` | `limit_exceeded` | This Coding Task stopped before it finished: it reached the limit of {limit}. Its work may be incomplete. |
| `VERIFICATION_FAILED` | `verification_failed` | This Coding Task was not verified: {failure message}. |
| `MODEL_FAILURE`, `MODEL_PROTOCOL_ERROR` | `model_failure`, `model_protocol_error` | This Coding Task stopped before it finished because a model request failed. |
| `CANCELLATION_TIMEOUT` | `cancellation_timeout` | The person cancelled this Coding Task, but a tool did not stop in time and may still be changing the repository. |
| `INTERNAL_ERROR` | `internal_error` | This Coding Task stopped before it finished because of an internal error in Coding Agent. |
| cut off by a crash (§4.8) | `interrupted` | Coding Agent stopped unexpectedly while working on this Coding Task. Its work may be incomplete, and tools that were running may have changed the repository partly. |

{limit} names the breached limit from the failure's details: "30 model turns", "100 tool calls", "10
minutes of active work" (in seconds when the limit is not a whole number of minutes), or "3
consecutive failed tool calls". {failure message} is the `VERIFICATION_FAILED` message of ADR 0003
§5, such as `the verification command "bun test" timed out after 30000 ms`.

**Naming request** (§4.10). Its system prompt is "Name this coding conversation from its first
task. Reply with the name only: at most 6 words, in the language of the task, with no quotes and no
full stop." Its one user message is the first Coding Task's objective.

### 3. Prompt Queue

#### 3.1 Shape and ids

- The Prompt Queue belongs to the Session. It holds two first-in, first-out lists, Steers and then
  Follow-ups. An item is `{ id, text }`.
- Coding Agent issues the id when an item enters, as `queued-<uuid>`. The id names no kind, because
  an item can change kind (§3.4, §3.6) and keeps its id. It is the id `SteerSource.take()` returns
  and `steer_taken.steerId` carries. Agent Core carries no Follow-up id: Coding Agent removes a
  Follow-up and opens its run itself.
- Text that is empty or only whitespace is never queued. There is no length cap.

#### 3.2 Taking Steers

The Prompt Queue implements Agent Core's `SteerSource` (ADR 0002 §8). `take()` removes and returns
the head Steer, or returns nothing when there is none or the head Steer is being edited (§3.6). It
is synchronous and the run commits the Steer in the same tick, so a queued item is either still in
the queue or already taken.

#### 3.3 When a Follow-up starts

- The queue moves on only after a run settles `succeeded`. The head Follow-up then opens a new Agent
  Run right after `run_settled`, with no delay, as that run's Coding Task.
- After any other outcome (cancelled, a failure code, `LIMIT_EXCEEDED`) nothing starts and the
  Follow-ups wait. There is no paused state and no resume Action: the person starts a run (§3.8),
  and when it succeeds the queue moves on again. Follow-ups chain like `&&`: "add tests" queued
  after "implement X" should not start on a state the person did not plan for.
- A run refused at open puts its Follow-up back at the head with the same id, adds a Session notice
  (§7.2), and the queue does not move on.

#### 3.4 Steers left when a run settles

- A run can settle without taking a waiting Steer: after a failure, a cancellation or a Run Limit,
  after a decided Verification, and at a Candidate Completion that verifies because another Model
  Turn would breach a limit (ADR 0002 §8). In each case every waiting Steer becomes a Follow-up at
  the head of the Follow-ups, keeping its id, text and order, and §3.3 decides whether it starts.
  After a success it therefore opens the next run at once, with fresh Run Limits.
- While no Agent Run is active, the Prompt Queue therefore holds only Follow-ups.

#### 3.5 After `CANCELLATION_TIMEOUT`

Nothing starts by itself (§3.3), and the person may start a run. A Session notice says that a tool
may still be changing the repository, and the Outcome Note tells the model.

#### 3.6 Send now, edit and delete

- Send now is offered on Follow-ups only. While a run is active, the Follow-up becomes a Steer at
  the tail of the Steers with the same id, so Steers are taken in the order they became Steers.
  While no run is active, it opens a new Agent Run now, ahead of the other Follow-ups. No action
  turns a Steer back into a Follow-up.
- Edit is in place: the item keeps its id, kind and place, and nothing takes it while it is being
  edited. A head Steer being edited makes `take` return nothing, so Steers keep their order; a head
  Follow-up being edited makes the queue wait. If the last run succeeded and no run is active when
  that edit ends (`queue.editEnd`, or `queue.delete` of that item), the head Follow-up opens its run
  at once, as after `run_settled` (§3.3). Saving replaces the text, abandoning keeps it, and saving
  empty text is refused. A Steer being edited when its run settles becomes a Follow-up and stays in
  edit.
- Delete removes the item by id. Deleting the item being edited ends the edit.

#### 3.7 Losing the race

Taking a Steer and starting a Follow-up's run are synchronous in Coding Agent, so each action either
lands first or finds its id gone. Send now, edit and delete name an id. If it is no longer queued,
the action is refused with `already_taken` for a Steer or `already_started` for a Follow-up (§7.3)
and nothing else changes. An edit can lose only when it begins. A taken Steer cannot be undone; the
person sends another.

#### 3.8 Submitting while no run is active

Both submit keys open a run with the typed text at once, whatever is waiting. The waiting Follow-ups
move on after it succeeds.

#### 3.9 A cancel names its Agent Run

- A client's cancel names the Agent Run it showed when the key was pressed. A cancel for a run that
  has settled changes nothing and is refused with `settled`, so an Esc meant for a run that succeeds
  just as its Follow-up starts does not cancel the Follow-up. A signal still cancels whatever run is
  active.
- A Steer typed just as a run settles may be taken by the next Follow-up's run. Its text still
  reaches the model in order.

#### 3.10 Lifetime

- The Prompt Queue lives in memory only, and the Session file does not record it.
- Quit, a new Session or a resume while Follow-ups wait discards them after a confirmation that
  gives their count (§7.4). Switching Session while a run is active is out of scope, so this happens
  only while no run is active. A signal or a crash discards them without asking.

### 4. Session file

#### 4.1 What it records

- One Session file per Session. Line 1 is a header; every later line is a Run Event or a record of
  Coding Agent's own.
- Every Run Event is written except `assistant_content_delta`, `tool_execution_progress` and
  `verification_progress`, the set `events.jsonl` leaves out (ADR 0005 §4). Written events keep
  their `sequence`, so omissions show as gaps.
- The Transcript is derived from the events that carry its messages (§4.6), and the Session view is
  redrawn from the same events (§4.9). Usage comes with them: each Model Turn's on
  `model_turn_completed`, each run's totals on `run_settled`.

#### 4.2 Lines and versions

Every line is a JSON object with `schemaVersion: 1` and `record`:

| `record` | Fields beside `schemaVersion` and `record` | Written |
| --- | --- | --- |
| `header` | `sessionId`, `createdAt`, `repoRoot` (canonical) | as line 1 |
| `event` | ADR 0002's envelope: `runId`, `sequence`, `occurredAt`, `type`, `data` | for each Run Event of §4.1 |
| `system_prompt` | `occurredAt`, `text`, `codingAgent` (`version`, `commit`), `tools` (the sorted registered tool names) | at creation, and when rebuilt (§4.7) |
| `name` | `occurredAt`, `name`, `usage` (the naming request's) | when the model names the Session (§4.10) |
| `interrupted` | `occurredAt`, `runId`, `toolResults` (one `{ providerToolCallId, message }` per call it closes), `outcomeNote` | once for each run a crash cut off (§4.8) |
| `reasoning` | `occurredAt`, `assistantMessageId`, `text` | just before the `assistant_message_completed` of a message whose reasoning streamed (§4.9) |

- Times are ISO-8601 strings, as `occurredAt` is, so every line has a time.
- The file is linear, with no `id` and `parentId` tree. Branching is not in stage 1; a tree would be
  a new record type.
- Reading: a line with an unknown `record` is skipped. A file with a higher `schemaVersion` is
  listed and its resume refused as newer. A malformed last line is a cut tail and is ignored. A
  malformed line elsewhere marks the file damaged: it is listed and its resume refused.
- `events.jsonl` does not change. The two files share the envelope serializer and the redactor, only
  Session file lines carry `record`, and each file numbers its `schemaVersion` on its own.
- Unlike `events.jsonl` (ADR 0005 §4), the Session file keeps a Tool Result's validated `details`
  on `tool_call_completed`, as optional JSON beside the rest of the Tool Result, as
  [CDA-155](https://datn-fit-hcmus.atlassian.net/browse/CDA-155) decided for saved Sessions. The
  model never sees them, so the Transcript does not depend on them.

#### 4.3 Location and file name

- `<CODING_AGENT_HOME>/sessions/<folder>/<time>_<id>.jsonl`. `CODING_AGENT_HOME` defaults to
  `~/.coding-agent`, with the home folder from `os.homedir()` (`%USERPROFILE%` on Windows).
- There is one folder per canonical Repository Root, not per git top level, because a Repository
  Root need not be a git repository. A Worktree is its own Repository Root (§6.10).
- `<folder>` is the root's basename with each character outside `A-Za-z0-9._-` replaced by `_` and
  cut to 40 characters, then `-` and the first 12 hex digits of the SHA-256 of the canonical
  Repository Root. On Windows the path is lowercased before hashing, because NTFS ignores case; Git
  Bash, MSYS, Cygwin and WSL drive paths are normalized before resolution. The suffix also keeps
  reserved names such as `CON`, and trailing dots, off the end.
- `<time>` is the creation time in UTC ISO-8601 with `:` and `.` replaced by `-`, since Windows
  forbids `:`. `<id>` is the Session id.
- The longest path is about 155 characters plus the user name, under `MAX_PATH`.

#### 4.4 Credentials and file modes

- No credential enters any event or record. Every line passes through the redactor that
  `events.jsonl` and the TUI already use, which replaces a credential value with `[redacted]` in
  every string and property name. Where a tool printed the key, the resumed Transcript differs from
  what the model saw.
- Files are created `0600` and folders `0700`, passed on every OS. Windows keeps only the read-only
  bit, so there the profile's ACL protects them.

#### 4.5 Writing

- The file is created with `wx` at the first `run_started`, together with the header and the
  `system_prompt` record held since the Session was created. A Session quit before its first Coding
  Task leaves no file.
- Each line is appended synchronously as Coding Agent receives it, with no fsync, so a kill loses at
  most the line being written. Only the holder of the Session lock writes (§5).
- On Windows an append that fails with `EBUSY` or `EPERM`, as when an antivirus or indexer holds the
  file, is retried up to 3 times over about 100 ms.
- A write that still fails stops writing that file for the rest of the process and adds a Session
  notice. The Session goes on in memory, and the file reads like a crash at that point (§4.8).

#### 4.6 Deriving the Transcript

Agent Core exports `transcriptFromRunEvents`, a pure function from one Agent Run's Run Events to the
messages that run appended (ADR 0004 §10). Coding Agent joins the runs in file order and adds the
messages of each `interrupted` record where it stands: its Closing Tool Results, then its Outcome
Note.

#### 4.7 System prompt

- A new Session builds its system prompt from the current files and keeps it in a `system_prompt`
  record.
- Resume reuses the latest `system_prompt` unchanged, since it continues the same conversation, so
  an `AGENTS.md` edit takes effect only in a new Session.
- Resume rebuilds the prompt, appends a new `system_prompt` and adds a Session notice only when
  Coding Agent's `version`, its `commit` or the tool names differ, or when the file has no
  `system_prompt`. A run from source has `commit: null`, and `null` equals `null`.

#### 4.8 After a crash

- On load, a run with `run_started` but neither `run_settled` nor an `interrupted` record was cut
  off, by a crash or by a failed write. Coding Agent appends one `interrupted` record for it. The
  record holds a Closing Tool Result in §2's wording for each `tool_call` block of the run's
  derived Transcript (§4.6) that has no `tool_result`, keyed by the block's provider Tool Call id,
  and the Outcome Note with `status="interrupted"`. A crash can fall between
  `assistant_message_completed` and its `tool_call_queued` lines, so queued calls alone are not
  enough, and a call that was never queued has no Agent Core id.
- Coding Agent writes the record before the first new Agent Run, because `openAgentRun` refuses a
  Transcript with an unanswered Tool Call (ADR 0002 §8), and adds a Session notice.
- Coding Agent never writes Agent Core's events itself: their `sequence` and payloads belong to
  Agent Core.
- A run still going in another terminal looks the same, so only the holder of the Session lock
  writes the record (§5.5).

#### 4.9 Redraw

- From an empty `TuiModel`, every stored line passes in file order through the projection of Session
  log entries (§7.2): each Run Event as it arrived, and each `interrupted` and `reasoning` record
  where it stands. Stored `details` go through the same projection, so an edit's diff is redrawn
  without rereading the edited file.
- An `interrupted` record ends what its run left unfinished: a streaming Assistant Message, a
  queued, awaiting or executing Tool Call (shown with its Closing Tool Result) and a running
  Verification become `cancelled`, the run's outcome becomes `interrupted`, and no pending Approval
  survives. Each Closing Tool Result finds its row by the provider Tool Call id that
  `tool_call_queued` carries; a call that was never queued has no row, so its result reaches only
  the Transcript.
- Coding Agent writes one `reasoning` record per Assistant Message whose reasoning streamed, so the
  redraw can put that reasoning back on its entry. No adapter streams displayable reasoning today,
  so none is written until one does.
- Notices are not stored. After a resume the only Session notices are the crash notice and the
  rebuild notice of §4.7, when they apply, besides the startup notices of §5.8 and §6.11. There is
  no `resumed` record and no separator, and the view opens at the bottom.

#### 4.10 Session name

- Until the model names it, a Session's name is the first non-empty line of its first Coding Task
  with whitespace collapsed, cut to the row width where it is shown.
- Once, right after the first `run_started` and in parallel with that run, Coding Agent sends §2's
  naming request to the Session's model through the same `ModelPort`: no tools, reasoning off where
  Model Capabilities allow, output capped at about 32 tokens, and a 30 s timeout.
- The answer's first line, with control characters and quotes removed, redacted and cut to 60
  characters, is written as a `name` record with the request's usage. The latest `name` record wins.
- The request is not part of an Agent Run: it counts against no Run Limit and emits no Run Event. A
  failure, the timeout, an empty answer or a Quit first writes no record, and the first line stays
  the name without a notice. Resume never asks again. There is no rename Action in stage 1.

#### 4.11 The Session's model

- A Session's recorded model is the model of its last Model Turn, which `model_turn_started` records
  with its provider. One Session can mix models. Which model a start or a resume uses is §9.5's.
- The Google adapter sends a Provider Signature only when the Assistant Message's model equals the
  request's (ADR 0004 §10). Gemini 3 validates signatures only in the current turn, and a resumed
  run starts with a new Coding Task, so the signatures it drops sit in earlier turns. Google's
  placeholder signature is not used.
- Unverified, and not affecting resume: whether OpenRouter's path to Gemini models, which carries no
  signature, works in Gemini 3 tool loops.

#### 4.12 Listing

- A Repository Root's Sessions are the `*.jsonl` files in its folder whose header `repoRoot`
  matches, each read in full. An entry gives the Session name, the last activity (the time of the
  last line), the number of Coding Tasks (`run_started` lines, so Steers do not count), the
  Session's model, and a status (§7.6).
- Entries are ordered by newest activity, and `--continue` uses the same order, not file mtime.
- Damaged and newer files are listed and marked. One listing function serves `session.list` and
  `coding-agent sessions`.

#### 4.13 Accepted limits

- A moved or renamed repository orphans its Sessions, except through `--session <id>` (§9.2).
- Nothing deletes old Session files. Deleting a Session means deleting its file, and the README says
  where the files are. Retention waits for a settings file.

### 5. Session lock

#### 5.1 Form and holder

- One lock file per open Session, created with `wx` and holding an owner record. Liveness comes from
  `process.kill(pid, 0)`, the hostname and the boot time. It needs only `node:fs` on Linux, macOS
  and Windows. Coding Agent owns the lock; Agent Core knows nothing of it.
- Every interactive Coding Agent holds exactly one Session lock, on its current Session, from the
  moment that Session exists. A new Session takes it at creation, before its file exists; a resumed
  Session takes it before its file is read. It is released on a Session switch or at exit.
- Headless takes no lock, is not detected and detects nothing.

#### 5.2 Place and record

- The lock is `<id>.lock`, beside the Session file in the Repository Root's sessions folder. It has
  no `<time>`, because the lock exists before the file. The folder is created `0700` when the first
  lock is taken, so a Quit before any Coding Task can leave an empty folder.
- The record is one JSON object: `schemaVersion: 1`, `instanceId` (a random UUID per process),
  `pid`, `hostname`, `bootTime` (`Date.now() - os.uptime() * 1000`), `repoRoot`, `sessionId` and
  `acquiredAt`. There is no process start time, for want of a cross-platform API.
- It is written with `openSync(path, "wx", 0o600)`, then the record, then close. On Windows a `wx`
  that fails with `EPERM` (a delete still pending right after another process released the lock) is
  retried up to 3 times over about 100 ms.

#### 5.3 Held or stale

- A lock is stale only when its `hostname` is this machine's and one of these holds: its `bootTime`
  differs from ours by more than 60 s; `process.kill(pid, 0)` throws `ESRCH`; or its `pid` is our
  own PID and its `instanceId` is not ours.
- Every other lock is held, including on `EPERM` (an elevated process or another user's), for
  another host (a remote PID means nothing here), and with a higher `schemaVersion`.
- An empty or unparsable lock, as in the instant between `wx` and the write, is held by an unknown
  owner while its mtime is under 10 s old, and stale after that.
- The 60 s tolerance absorbs a stepped wall clock, which moves the computed boot time; a tight
  tolerance could make a live holder look rebooted. A crash plus a reboot within 60 s of the
  previous boot is negligible.
- One pure function decides, from the record and injected probes: the `kill` result, the hostname,
  the boot time, the clock and the mtime.

#### 5.4 Taking a lock

- With no lock yet, `wx` wins or loses. The loser reads the record and reports the Session as open
  elsewhere.
- A stale lock is taken over under a guard, as git's `gc` does: create `<id>.guard` with `wx`
  holding the same record, re-read the lock and unlink it only if its bytes equal the ones judged
  stale, then `wx` our own lock and remove the guard. The final `wx` can still lose to a fresh
  opener, which then holds the Session, and the loser reports open elsewhere.
- A held guard is retried every 50 ms for up to 1 s, after which the Session counts as open
  elsewhere. A guard judged stale by §5.3, or older than 10 s, is deleted. That deletion can race
  only with a crash inside the guard's few milliseconds and two reclaimers at once, which is
  accepted.
- A takeover shows no notice. The crash notice (§4.8) appears when a run was cut off.

#### 5.5 Order, release and signals

- Resume takes the lock, then reads the file, then appends the `interrupted` patch, then redraws.
  The file is read after the lock because the previous holder may have appended until it released.
- A switch, to a new Session or a resumed one, takes the new lock first and releases the old one
  after. If the new lock is held, the person stays in the current Session.
- The lock is released only after the last line is written: on Quit, on a Session switch, and in a
  synchronous `process.on("exit")`. Releasing reads the lock and unlinks it only if its `instanceId`
  is ours. Released before `run_settled`, it would let another terminal patch that run as
  `interrupted` while this one still writes it.
- The interactive path adds SIGHUP (a closed terminal) to SIGINT and SIGTERM: cancel, settle, write,
  release, exit 130. Windows kills a process about 10 s after its console closes, and the default
  Cancellation Grace Period is 5 s, so a cancelled run usually settles and releases in time;
  otherwise §5.3's PID rule clears the lock. Headless keeps its signal handling.
- SIGKILL, a crash or a power loss leaves the lock for §5.3 to judge.

#### 5.6 Refusals

- `--continue` on a held newest Session exits 2 before the TUI draws: "The latest Session, "fix
  login redirect", is open in another terminal (PID 4242). Quit it there, or use --resume to pick
  another Session. If no Coding Agent is running as PID 4242, delete <path>." For another host the
  PID reads "(PID 4242 on build-01)". `--session <id>` on a held Session gets the same refusal,
  naming that Session.
- The lock's path is the escape hatch for a reused PID, as git's message is for `index.lock`. There
  is no takeover flag or Action in stage 1.
- In the Session picker a held row is dimmed. The cursor can land on it, and Enter shows a one-line
  notice and keeps the picker open. A row that looked free but whose lock another terminal took
  first turns dimmed, with a notice that it was just opened elsewhere. The Session this process
  holds is shown as current.

#### 5.7 Listing

The Session picker and `coding-agent sessions` read `<id>.lock`, if present, for each `<id>.jsonl`
and apply §5.3. They never delete or take over a lock, so a stale lock leaves its Session free to
pick. The state is read when the list is built and is not refreshed while it is shown.

#### 5.8 Another Coding Agent on the same Repository Root

- After taking its lock, a starting Coding Agent reads the `*.lock` files in its lock's folder and
  keeps the held ones whose `repoRoot` equals its own, compared as §4.3 hashes it, minus its own
  `instanceId`. Taking the lock before reading means two simultaneous starts see each other.
- Only equal Repository Roots count. Nested roots are not warned, and git top levels are not
  compared, since a Repository Root need not be a git repository.
- It adds one Session notice, once per process start: "Another Coding Agent is running in ~/shop
  (PID 4242, Session "fix login redirect")." With more than one it gives the count and the newest
  holder. It names the path, because "this directory" is wrong when `--repo-root` points elsewhere,
  and it leaves out the Session part when the holder's Session has no file yet.
- It is not repeated on a new Session or a resume, the instance that started first is not told, and
  it is not stored.

#### 5.9 Failures and accepted limits

- When the lock cannot be written for any reason but `EEXIST`, such as a read-only home or a full
  disk, a new Session goes on in memory with the Session notice "Sessions are not saved: <error>"
  and writes no Session file, since a write without the lock would break the single-writer rule. A
  resume is refused with the error: exit 2 for `--continue` and `--session`, a notice in the picker.
- A Session file write that fails later (§4.5) keeps the lock until a switch or exit.
- A reused PID keeps a dead lock held until reboot, and the refusal's path is the way out. Windows
  can reuse a PID as soon as its process ends, so there the PID check carries more of the weight.
- There is no sweep: a crash leaves one lock, replaced when its Session is next opened.
- `wx` on a network file system is untested. Coding Agents with different `CODING_AGENT_HOME`s do
  not see each other, and headless runs are not seen.

### 6. Worktrees

The starting checkout is the git working tree that holds the Repository Root Coding Agent was given,
the working directory by default.

#### 6.1 Location

- `--worktree [name]` creates the Worktree at `<CODING_AGENT_HOME>/worktrees/<folder>/<name>/`.
- `<folder>` is keyed by the repository's shared git directory (`git rev-parse --git-common-dir`),
  so the main checkout and every linked worktree of one repository share it. It takes §4.3's form: a
  readable part, `-`, and the first 12 hex digits of the SHA-256 of the canonical shared git
  directory, lowercased on Windows before hashing. The readable part is the main working tree's
  basename (the shared git directory's parent when that directory is named `.git`), or, for a bare
  repository, the shared git directory's basename without `.git`.
- `worktrees/` and each `<folder>` are created `0700`. Git creates each Worktree folder itself.
- Nothing appears in the repository, and isolation runs both ways: the main checkout's tools and
  Path Jail never see the Worktree, and the Worktree's never see the main checkout.

#### 6.2 Base and branch

- A new Worktree starts from the HEAD of the starting checkout, which is a linked worktree's own
  HEAD when Coding Agent starts in one. There is no fetch, so no network and no credential prompt,
  and unpushed commits come along. No flag picks another base in stage 1.
- Uncommitted changes in the starting checkout are not in the Worktree; the creation notice says so
  (§6.11).
- The branch is `coding-agent/<name>`. It never collides with the person's branches, and cleanup can
  tell its own branches apart. Under the team's branch convention, push with
  `git push origin HEAD:CDA-12-...` or rename the branch first.

#### 6.3 Names

- A given name is 1 to 40 characters of lowercase letters, digits and `-`, starting and ending with
  a letter or digit, and not a Windows device name (`con`, `prn`, `aux`, `nul`, `com1` to `com9`,
  `lpt1` to `lpt9`). It is then a valid folder name on all three OSes and a valid ref component, and
  no two names differ only in case. Anything else is a usage error, exit 2.
- With no name, Coding Agent generates `<adjective>-<noun>-<4 hex>`, such as `bold-oak-a3f2`, from
  short word lists in its source, and generates again when the name clashes with an existing
  Worktree folder or branch.

#### 6.4 Starting and refusals

- `--worktree` is interactive only: `coding-agent run --worktree` is a usage error, exit 2.
- Before the TUI draws, Coding Agent exits 2 with "--worktree needs a git repository: <root> is not
  in one" outside a git working tree, bare repositories included; "--worktree needs a commit to
  start from" in a repository with no commits; and "--worktree needs git, which was not found on
  PATH". There is no hook for other version control systems.
- Order: resolve the repository and the Session's Repository Root (§6.6), canonicalizing from the
  deepest existing parent as ADR 0001 §2 does for new paths; take the first Session lock (§5.1);
  wait on a removal guard (§6.9); then apply §6.5. A refusal after the lock releases it before exit
  2.

#### 6.5 What `--worktree <name>` finds

Checked in order:

1. `<folder>/<name>` exists and is a worktree of this repository: reopen it as it is, whatever
   branch it has checked out, with no new branch, no reset and no copy.
2. It exists but is not a worktree of this repository: refuse, exit 2.
3. No folder, but branch `coding-agent/<name>` exists: recreate the Worktree on that branch, with no
   new branch and no base. A registered worktree whose folder was deleted by hand is pruned first,
   since git otherwise refuses it as "a missing but already registered worktree". If git reports the
   branch "already used by worktree at <path>", as under another `CODING_AGENT_HOME`, refuse with
   exit 2 and that path.
4. Neither: create the Worktree and `coding-agent/<name>` from the base (§6.2).

- Two terminals creating one name at once both reach case 4, and one `git worktree add` wins. The
  loser applies §6.5 once more, reopens the winner's Worktree through case 1, and gets §5.8's
  notice. A loser with a generated name generates another instead.
- A Worktree is never moved or renamed while in use.

#### 6.6 The Session's Repository Root

- The Session's Repository Root is the given Repository Root's path relative to the starting
  checkout's top level, taken inside the Worktree: `--repo-root packages/ai --worktree` gives
  `<worktree>/packages/ai`. That keeps the Path Jail the person chose.
- If that folder does not exist in the Worktree, because it was untracked or ignored in the starting
  checkout, Coding Agent exits 2. In case 4 it first removes the new Worktree and its branch, in
  case 3 it removes the recreated Worktree and keeps the branch, and in case 1 it touches nothing.
- Started inside a linked worktree, whether Coding Agent's or the person's, the new Worktree belongs
  to the same repository: the same `<folder>`, and that checkout's HEAD as the base.
- The Repository Root never changes within a process, so a new Session or a resume from the TUI
  stays in the Worktree.
- A worktree the person made with `git worktree add` is a plain Repository Root, which Coding Agent
  neither reopens nor removes.

#### 6.7 Files copied from `.worktreeinclude`

- `.worktreeinclude`, in gitignore syntax, is read from the starting checkout's top level, also when
  Coding Agent starts in a subfolder. It needs no settings file.
- Git does the matching: `git ls-files --others --ignored --exclude-from=.worktreeinclude`, keeping
  only the files `git check-ignore` confirms the repository ignores. An unanchored `*.env` also
  matches inside ignored folders such as `node_modules/`, so `/.env` anchors it. The walk enters
  ignored folders, which costs time on big trees.
- Files are copied once, after §6.6's check, when the Worktree is created or recreated (cases 3 and
  4), never on reopen, so a file deleted in the Worktree stays deleted.
- A source or destination path with a symbolic link in it is skipped, as the Path Jail would. An
  existing destination is skipped (`COPYFILE_EXCL`), so nothing is overwritten. Permission bits are
  kept, so a `0600` `.env` stays `0600`. There is no size or count cap: a listed folder is copied
  whole.
- A failed copy does not stop the start; the creation notice gives the count and the first failure.
- Copying `.env` adds no exposure, since `read` can already read it in the main checkout. Nothing
  else is set up: dependencies come from `bun install` under Approval, and a symlinked
  `node_modules` would be rejected by the Path Jail.

#### 6.8 Cleanup at exit

- Cleanup runs only after Quit in a process started with `--worktree` (§9.8), once the last Session
  line is written and before the Session lock is released. A signal, a crash or a failed removal
  keeps the Worktree.
- Coding Agent removes the Worktree with `git worktree remove`, never `rm -rf`, and deletes
  `coding-agent/<name>`, only when nothing would be lost:
  - `git status --porcelain` is empty: no changes to tracked files and no untracked files;
  - every commit on HEAD and on `coding-agent/<name>` is also on another branch, a tag or a
    remote-tracking branch, so
    `git rev-list --count <ref> --not --exclude=coding-agent/<name> --branches --tags --remotes` is
    0 for both (an `--exclude` before `--branches` omits `refs/heads/`);
  - no other Coding Agent holds a Session lock whose `repoRoot` is the Worktree or inside it (§6.9).
- Otherwise the Worktree and its branch both stay, with no prompt, for given and generated names
  alike. Coding Agent never deletes any other branch, even one checked out in the Worktree.
  Gitignored files, such as a copied `.env` or `node_modules`, go with a removed Worktree:
  `git worktree remove` deletes them without `--force`.
- After the TUI closes, Coding Agent prints "Worktree <name> removed: nothing in it would be lost",
  or "Worktree kept at <path> (branch coding-agent/<name>): <reason>. Resume: coding-agent
  --worktree <name> --continue". The reason is the first found: uncommitted changes, untracked
  files, commits on no other branch, another Coding Agent in it, or the removal error.
- Cleanup never changes the exit code.

#### 6.9 Removal guard

- The remover creates `<folder>/<name>.removing` with `wx`, holding §5.2's owner record. It then
  reads every `*.lock` under `sessions/`, because a Repository Root can be a subfolder of the
  Worktree whose sessions folder it cannot name in advance, and keeps the held ones whose `repoRoot`
  is the Worktree or inside it, minus its own `instanceId`. With none left, it removes the Worktree,
  then deletes the guard.
- Every opener whose Repository Root lies under `<CODING_AGENT_HOME>/worktrees/` takes its Session
  lock before it looks for the guard, whose path it derives from its own. While the guard's owner is
  alive by §5.3, the opener checks again every 50 ms with no time limit, since removing a large
  ignored folder takes seconds, and after 1 s prints once to stderr "Waiting for Coding Agent PID
  4242 to finish removing worktree <name>". A `--worktree` opener then applies §6.5 again, so case 3
  or 4 recreates what was removed; any other opener finds its root gone (§6.10).
- A guard judged stale by §5.3 is deleted.
- Either the remover sees the opener's lock and keeps the Worktree, or the opener sees the guard and
  waits.

#### 6.10 Listing and resume

- A Worktree is its own Repository Root, with its own sessions folder, and §5.8 compares it like any
  root. The main checkout's list never shows a Worktree's Sessions.
- While the Worktree exists, its Sessions are resumed with `--worktree <name>` plus `--continue`,
  `--resume` or `--session <id>`, which read that Worktree's own list, or by starting Coding Agent
  inside the Worktree.
- `--worktree` with no name plus a Session flag is a usage error. `--worktree <name>` plus a Session
  flag in §6.5's case 4 exits 2: "No worktree <name> to resume: its folder and branch are gone". It
  does not create a fresh Worktree to continue an old conversation in.
- Resuming any Session whose header `repoRoot` no longer exists exits 2 and names the path. When the
  path lies under `<CODING_AGENT_HOME>/worktrees/`, the message adds "If branch coding-agent/<name>
  still exists, run coding-agent --worktree <name> --session <id> in its repository". The branch is
  not checked, since `<folder>` holds a hash Coding Agent cannot map back to a repository.
- A new Worktree at a reused path lists that path's earlier Sessions. A second terminal on the same
  name is allowed and gets §5.8's notice.

#### 6.11 Notices

All are Session notices, shown once at startup in a process started with `--worktree`, and not
stored:

- Created: "Worktree bold-oak-a3f2 at <path>, branch coding-agent/bold-oak-a3f2 from abc1234". When
  the starting checkout is dirty it adds "uncommitted changes in <path> are not in it". When
  `.worktreeinclude` copied files or failed, it adds the count and the first failure: "Copied 2
  files from .worktreeinclude; could not copy config/local.json: permission denied".
- Recreated: "Worktree <name> recreated at <path> from branch coding-agent/<name> (def5678)", plus
  the copy line.
- Reopened: "Worktree <name> reopened at <path> (branch <branch>)".

The system prompt does not mention the Worktree, its branch or the main checkout. Its
working-directory line already names the Worktree, and naming the main checkout would invite the
model to go there.

#### 6.12 Git commands

Every git command Coding Agent starts for a Worktree runs with the environment that Tools'
`createChildEnvironmentBuilder` builds, without the provider credentials, because
`git worktree add` runs the repository's `post-checkout` hook (ADR 0001 §7).

#### 6.13 Accepted limits

- A crash or a signal leaves its Worktree, and there is no sweep; `git worktree list` shows them. A
  crash during `git worktree remove` can leave a partly removed Worktree, which §6.5 then reopens;
  since only clean Worktrees are removed, `git restore .` or `git worktree remove --force` recovers.
- An editor or shell the person has open in a removed Worktree is not detected.
- Coding Agents with different `CODING_AGENT_HOME`s do not see each other's Worktrees, and a branch
  checked out under one makes §6.5 refuse under the other.
- Git only.
- On Windows a Worktree root can reach about 130 characters plus the user name below the drive
  before the repository's own paths. Only names near 40 characters in deep trees come close to
  `MAX_PATH`.

### 7. Session Controller

#### 7.1 Controller and clients

- Coding Agent's Session Controller owns the current Session, its Prompt Queue and its active Agent
  Run, and carries out the Actions with every condition on them and every refusal. Its API is
  neutral to any interface: its state and its Actions, with no modes, cursor or keys.
- A client drives it. In stage 1 the only client is the Full-screen TUI, through a TUI adapter in
  Coding Agent that projects the controller's updates into `TuiModel` and passes Actions through.
- `tui` owns the interaction: modes, the selected row, the key table, hints, and asking for
  confirmation from the facts the controller gives. The controller checks every condition again, so
  another client can attach later without changing it.
- The controller's state, Actions and replies are JSON only: times are epoch ms and no functions are
  passed.
- `interactive.ts` is rewritten around the controller.

#### 7.2 State and updates

```typescript
interface ControllerState {
  session: {
    id: string;
    name: string;
    root: string; // the absolute Repository Root
    model: { provider: string; id: string }; // the model the next Agent Run uses (§9.5)
  };
  // From the run's start until it settles.
  run?: { id: string; modelTurn: number; maxModelTurns: number };
  queue: {
    items: { id: string; kind: "steer" | "followUp"; text: string }[]; // Steers, then Follow-ups
    editing?: string; // the item locked for an edit
    waiting?: "failed" | "cancelled" | "limit"; // why Follow-ups do not start
  };
}

type ControllerUpdate =
  | { type: "opened"; log: SessionLogEntry[]; state: ControllerState }
  | { type: "appended"; entry: SessionLogEntry }
  | { type: "state"; state: ControllerState };
```

- The `SessionController` has `state()` and `subscribe(listener)`. `subscribe` sends an `opened`
  with the current log and state at once, then every later update, so a client that attaches at any
  time can redraw. A new or resumed Session sends another `opened`.
- A `SessionLogEntry` is a Run Event, deltas and progress included; an `interrupted` or `reasoning`
  record (§4.2); or a Session notice `{ id, text }`. Deltas and progress are published but never
  written to the Session file.
- `maxModelTurns` comes from the Run Limits the run was opened with, since `run_started` carries
  only the task.
- The adapter redraws on `opened` from an empty `TuiModel`, projects each `appended` entry with
  `projectSessionLogEntry` (ADR 0004 §10), and maps each `state` onto `TuiModel`'s `session`, `run`
  and `queue`.
- Session notices belong to the Session's history and show as rows of the Session view, as text the
  controller writes:

| When | Text |
| --- | --- |
| a resumed Session's last run was cut off (§4.8) | The last Coding Task was cut off when Coding Agent stopped unexpectedly. Its unfinished Tool Calls are closed as not completed. |
| the system prompt is rebuilt on resume (§4.7) | System prompt rebuilt: Coding Agent changed from 0.3.0 (abc1234) to 0.4.0 (def5678). The other reasons read "the tools changed" and "the Session file had none". |
| another Coding Agent runs on the same Repository Root (§5.8) | Another Coding Agent is running in ~/shop (PID 4242, Session "fix login redirect"). |
| the Session lock cannot be written (§5.9) | Sessions are not saved: <error> |
| a Session file write fails (§4.5) | This Session is no longer saved: <error> |
| a Worktree is created, recreated or reopened (§6.11) | the texts of §6.11 |
| a run settles `CANCELLATION_TIMEOUT` (§3.5) | A tool did not stop when the Coding Task was cancelled and may still be changing the repository. |
| a Follow-up the controller opened could not start (§3.3) | The next Follow-up could not start: <message>. It is back at the head of the queue. |
| Ctrl+R picks a Session whose model is missing or fails the checks (§9.5) | Kept anthropic/claude-x: the resumed Session has no model. With a failed check it names the reason, as §9.5's exit message does. |

Only the crash and rebuild notices come back after a resume (§4.9).

#### 7.3 Actions and replies

- Every Action returns a reply, `{ ok: true, ... }` or `{ ok: false, reason }`: synchronously for
  `queue.*` and `app.quit`, and through a Promise for `session.*` and `run.*`. State changes still
  arrive as updates; a reply only answers its Action.
- A reason is a code, with data where needed, and the client words it.
- After `app.quit` or a signal, every Action is refused with `stopping`. `not_queued` is an id that
  was deleted, dequeued, discarded or never issued.

| Action | Args | Reply | `ok` carries | Refusals |
| --- | --- | --- | --- | --- |
| `session.submit` | `text`, `kind` | Promise | `runId` or `itemId` | `empty_text`, `failed {message}` |
| `session.new` | `discard` | Promise | `sessionId` | `run_active`, `follow_ups_waiting {count}`, `failed {message}` |
| `session.list` | none | Promise | `root`, `sessions` | `failed {message}` |
| `session.resume` | `sessionId`, `discard` | Promise | nothing | `run_active`, `follow_ups_waiting {count}`, `current`, `held {pid, hostname?}`, `damaged`, `newer`, `not_found`, `failed {message}` |
| `run.cancel` | `runId` | Promise | nothing | `settled` |
| `run.resolveApproval` | `runId`, `approvalId`, `decision`, `reason?` | Promise | nothing | `settled`, `failed {message}` |
| `queue.sendNow` | `itemId` | sync | nothing | `already_taken`, `already_started`, `not_queued`, `not_follow_up`, `editing` |
| `queue.edit` | `itemId` | sync | nothing | `already_taken`, `already_started`, `not_queued`, `editing` |
| `queue.editEnd` | `itemId`, `text?` | sync | nothing | `not_editing`, `empty_text` |
| `queue.delete` | `itemId` | sync | nothing | `already_taken`, `already_started`, `not_queued` |
| `queue.dequeue` | none | sync | `texts`, Steers then Follow-ups | `editing` |
| `app.quit` | `discard` | sync | nothing | `run_active`, `follow_ups_waiting {count}` |

- `session.submit`'s `kind`, `"steer"` or `"followUp"`, says what the text becomes during a run.
  With no run active, either kind opens a run at once (§3.8). A failed open is refused with `failed`
  and adds no Session notice.
- `run.cancel` names its Agent Run (§3.9). `run.resolveApproval` mirrors ADR 0002's
  `resolve_approval`.

#### 7.4 Discarding waiting Follow-ups

- `session.new`, `session.resume` and `app.quit` take `discard: number`, `0` when nothing waits.
  When Follow-ups wait and `discard` differs from their count, the controller refuses with
  `follow_ups_waiting {count}`. Every client must therefore confirm, and a stale count never
  discards more than the person agreed to.
- `app.quit` is refused with `run_active` while a run is active, as a guard against a client out of
  step: to quit during a run, cancel first. A signal still ends the process at once with 130.

#### 7.5 The edit lock

- `queue.edit {itemId}` locks the item. `queue.editEnd {itemId, text?}` unlocks it, saving `text`
  when given and keeping the old text when not.
- Saving empty text is refused with `empty_text`, and the lock stays. One item is locked at a time:
  another `queue.edit` is refused with `editing`, and so are `queue.sendNow` and `queue.dequeue`
  while an item is locked. `queue.delete` on the locked item ends the edit.
- Ending the edit of the head Follow-up after a success opens its run (§3.6).

#### 7.6 Session list

- Opening and closing the Session picker is the client's. `session.list` reads the Session files and
  locks when called (§4.12, §5.7) and returns `{ root, sessions }`, newest first.
- An entry, a `SessionListEntry`, is `{ id, name?, lastActivity, codingTasks?, model?, status }`:
  `lastActivity` in epoch ms, `codingTasks` absent for a damaged file, `name` absent for a newer
  one, and `model` absent for a Session with no Model Turn.
- `status` is the first that applies of: `current`; `damaged` or `newer`;
  `openElsewhere {pid, hostname?}`, with `hostname` only for another host; `interrupted`; `free`. A
  Session another live process holds often looks cut off too, so open elsewhere wins.
- `session.resume` refuses with a reason, `held` included when another terminal won the lock, and
  the TUI then dims that row.

#### 7.7 Startup

- The controller is created with what to open first: `{ open: "new" }` or
  `{ open: "resume", sessionId }`. Creation runs the same path as `session.resume`, with the same
  refusal codes (`held`, `damaged`, `newer`, `not_found`, `failed`), and the command line words each
  as an exit 2 message before the TUI draws (§9).
- `--continue` picks its id with the listing function. `--resume` is `{ open: "new" }` plus a TUI
  that starts in picker mode.
- `coding-agent sessions` calls the listing function directly, with no controller and no lock.

### 8. Terminal UI

The prototype on branch `prototype/cda-144-queue-strip-and-picker` (variant D in
`packages/tui/prototype-cda-144/`, with `snapshots.txt`) shows the frame, the Queue strip, the queue
selection mode and the Session picker. It is throwaway code, to be rewritten rather than promoted.

#### 8.1 The `tui` surface

```typescript
export function renderTui(props: {
  model: TuiModel;
  handlers: TuiHandlers;
  keySet?: "standard" | "windows";
  hints?: "symbols" | "words";
}): TuiHandle;

export type TuiHandlers = {
  onAction<K extends keyof TuiActions>(id: K, args: TuiActions[K]["args"]): TuiActions[K]["reply"];
};

export interface TuiModel {
  // Was transcript of TranscriptEntry; the outcome status gains "interrupted".
  sessionView: readonly SessionViewEntry[];
  pendingApproval?: PendingApproval;
  session: { id: string; name: string; root: string; model: { provider: string; id: string } };
  run?: { id: string; modelTurn: number; maxModelTurns: number };
  queue: {
    items: readonly QueuedItem[];
    editing?: string;
    waiting?: "failed" | "cancelled" | "limit";
  };
}
```

- One handler replaces three: `onSubmit`, `onCancel` and `onApproval` give way to `session.submit`,
  `run.cancel` and `run.resolveApproval`.
- `TuiActions` is `tui`'s own mirror of the controller's Actions (their ids, args and replies) and
  its fifth public name. `tui` still imports nothing (ADR 0004 §1). A type-level test in
  `coding-agent` checks that the controller's Actions are assignable to it, as `tui` already mirrors
  ADR 0002's statuses. A shared types package waits for a remote client.
- `session`, `run` and `queue` mirror `ControllerState`. `TuiModel` has no field for the
  bottom-border notice, which the TUI words itself.
- The TUI formats the root (`~/shop`), the run state, `lastActivity`, the badges, the counts and the
  words of every reason.
- `keySet` and `hints` default to what `tui` detects: the Windows set on `win32` or under WSL
  (`WSL_DISTRO_NAME` or `WSL_INTEROP` set), symbols on macOS and words elsewhere. Tests pass them.

#### 8.2 Frame

- A frame surrounds the whole screen. The top border shows the Session name, the Repository Root and
  the Session's model, with the run state on the right: a spinner with `running · turn 2/4` during
  a run, an amber `! waiting` while Follow-ups wait (§3.3), and a green `● idle` otherwise.
- Inside, top to bottom: the Session view, or the Session picker in its place (§8.5); a separator;
  the Queue strip and a second separator, only while something is queued; and the Prompt, marked
  `›`.
- The bottom border holds the key hints for the current mode, or a notice in amber in their place,
  and on the right the counts, such as `2 steer · 2 next`.
- Session notices are rows of the Session view, in amber.

#### 8.3 Queue strip

- One row per item above the Prompt, Steers first and then Follow-ups, each in queue order. At most
  6 rows show; the rest are counted in an "N more above" or "N more below" row.
- Each row starts with a coloured badge: a violet `STEER` for a Steer, an aqua `NEXT` for a
  Follow-up, and an amber `WAIT` for a Follow-up while Follow-ups wait, under a row that says why:
  the last run failed, was cancelled or hit a Run Limit.
- A row shows the item's first line, dimmed. The selected row expands to its full text,
  word-wrapped, with the badge on the first line and the rest indented under the text.

#### 8.4 Queue selection mode and edit

- Shift+Up from the Prompt selects the item nearest the Prompt. Up and Down move, Down past the last
  item returns to the Prompt, and the Prompt keeps its draft. The mode ends by itself when the queue
  empties.
- Enter sends the selected Follow-up now. On a Steer it changes nothing and says that the Steer
  already goes before the next Model Turn.
- `e` edits the selected item in its row, which keeps its badge and shows `edit` before the text:
  Enter saves, Shift+Enter starts a line, Esc keeps the old text, and saving empty text is refused
  with a notice. `d` deletes the selected item.
- When the run takes the selected Steer, or the selected Follow-up starts, a notice says so.

#### 8.5 Session picker

- The picker fills the frame in place of the Session view and the strip, under the heading "Resume
  a Session in ~/shop · newest first". It lists the current Repository Root's Sessions, one row
  each: a status mark, the Session name, the last activity, the number of Coding Tasks and the
  status in words.
- Marks: a green `●` for this Session, an amber `●` for one open in another terminal (with its PID),
  a red `●` for one whose last run was cut off, `✕` for a damaged or newer one, and `○` for the
  rest. Held, damaged and newer rows are dimmed.
- It opens on the newest Session other than the current one. There is no filter in stage 1.
- Enter on a row marked current, open elsewhere, damaged or newer is refused by the TUI itself, and
  the picker stays open.

#### 8.6 Cancel, Quit and confirmations

- In the queue selection mode, an edit and the Session picker, Esc only leaves the mode, while
  Ctrl+C still cancels the active run. At the Prompt both keys cancel the run shown, with
  `run.cancel {runId}`. The cancel keys no longer work the same in every mode.
- With no run shown, the cancel key is a Quit press in every mode. The first press asks for
  confirmation, giving the number of waiting Follow-ups: "Quit discards 2 waiting Follow-ups. Press
  again to quit." The second calls `app.quit {discard}`. The request to press again shows in the
  bottom border, no longer in the Session view.
- With nothing waiting, Ctrl+N calls `session.new {discard: 0}` at once, and a notice says the
  previous Session is in the Session picker. With Follow-ups waiting, the first press asks and the
  second sends their count. Enter in the Session picker does the same for `session.resume`.
- Ctrl+N and Ctrl+R are refused with a notice while a run is shown, and the controller refuses
  `session.new` and `session.resume` with `run_active` as well.
- The Prompt is cleared as soon as the person submits. A refused `session.submit` puts the text back
  at the start of the Prompt, ahead of anything typed since, and shows the reason. The texts
  `queue.dequeue` returns are joined with a blank line and put ahead of the draft, in Pi's order.
- A refusal or a confirmation shows in the bottom border and clears at the next key. What the TUI
  sees for itself (the selected item taken or started, Enter on a Steer, a press to repeat) it words
  itself.

#### 8.7 Key table

The key table is data in `tui`, by context, as Pi-style key strings, with a standard and a Windows
set. Each binding is named by an Action id or by a TUI command id: `prompt.submit`,
`prompt.followUp`, `prompt.newLine`, `queue.select`, `picker.open`, `mode.leave` or `run.cancel`.

| Context | Binding | macOS, Linux | Windows, WSL |
| --- | --- | --- | --- |
| Prompt | `prompt.submit` | enter | enter |
| Prompt | `prompt.followUp` | alt+enter | ctrl+q, alt+enter |
| Prompt, edit | `prompt.newLine` | shift+enter, ctrl+j | shift+enter, ctrl+j |
| Prompt | `queue.select` | shift+up | shift+up |
| Prompt | `queue.dequeue` | alt+up | alt+q |
| Prompt | `session.new` | ctrl+n | ctrl+n |
| Prompt | `picker.open` | ctrl+r | ctrl+r |
| Prompt | `run.cancel` | escape, ctrl+c | escape, ctrl+c |
| Queue selection | `queue.sendNow` | enter | enter |
| Queue selection | `queue.edit` | e | e |
| Queue selection | `queue.delete` | d | d |
| Edit | `queue.editEnd` | enter | enter |
| Session picker | `session.resume` | enter | enter |
| Queue selection, edit, picker | `mode.leave` | escape | escape |
| Queue selection, edit, picker | `run.cancel` | ctrl+c | ctrl+c |

- `prompt.submit` runs a Coding Task with no run active and sends a Steer during one;
  `prompt.followUp` queues a Follow-up, or runs the text when no run is active (§3.8).
- `mode.leave` in an edit calls `queue.editEnd {itemId}` without text: the old text stays and the
  lock ends.
- Alt+Enter no longer starts a line. Up never enters the queue: it keeps moving between Prompt rows
  and stays free for a later Prompt history.
- On Windows, Windows Terminal takes Alt+Enter for full screen and VS Code takes Ctrl+Q, so Ctrl+Q
  is listed and Alt+Enter kept as a second, unlisted key. Ctrl+Enter arrives there as Ctrl+J.
- Fixed, outside the table: the arrows, Home and End, Backspace and Delete, Page Up and Page Down,
  and the Approval overlay with its deny reason, which keep their keys.
- The table is not exported in stage 1. Group 3's item 17 adds a `renderTui` parameter for a
  configured table, which Coding Agent reads from the configuration file.
- Unmeasured: what macOS Terminal, and iTerm2 and kitty with Option left as typed characters, send
  for Option+Return and Option+Up, so Alt+Enter and Alt+Up may not arrive there; and whether the
  kitty keyboard protocol reaches a native Windows process behind ConPTY, which decides whether
  Shift+Enter works there.

#### 8.8 Hints

- Hints show a binding's first key, so Windows' Alt+Enter stays unlisted. macOS shows key symbols
  (`⏎`, `⌥`, `⇧`, `⌃`, and glyphs for Up and Down) with `esc` spelled out; Linux and Windows show
  words, as in `Enter steer · Ctrl+Q follow-up · Shift+Up queue · Esc cancel · Shift+Enter new
  line`.
- Each mode lists, in order:
  - the Prompt during a run: steer, follow-up, queue, cancel, new line;
  - the Prompt with no run: run, queue, resume, new, quit (the cancel key twice);
  - the queue selection mode: send now, edit, delete, move, back, cancel run;
  - an edit: save, new line, keep old text;
  - the Session picker: open, move, close.

### 9. Command line

#### 9.1 Flags

```text
coding-agent [--repo-root <dir>] [--worktree [name]]
             [-c | --continue | -r | --resume | --session <id>]
             [--provider <provider> --model <model-id>]
coding-agent sessions [--repo-root <dir>] [--worktree <name>] [--json]
```

- Root flags pick the Repository Root: `--repo-root <dir>` and `--worktree [name]`, which combine
  (§6.6).
- Session flags pick the Session within that root: `-c`/`--continue`, `-r`/`--resume` and
  `--session <id>`. At most one is allowed; two is a usage error, exit 2: "--continue and --session
  cannot be combined". With none, a new Session starts.
- `--provider` and `--model` are optional and go together. One alone is a usage error: "--provider
  and --model go together".
- `-c` and `-r` are the only short flags, as in Pi and Claude Code. The parser gains valueless flags
  and `--worktree`'s optional value.
- `coding-agent run` takes none of these: it still answers "unknown flag", and its `--provider` and
  `--model` stay required (ADR 0005 §3).
- There is no `--no-session` in stage 1.

#### 9.2 `--session <id>`

- It takes an id, never a path: at least 4 characters of hex digits and `-`, matched without case
  against the `<id>` in `<time>_<id>.jsonl` file names, so the lookup reads names only. Anything
  else is a usage error. A full id always wins over a prefix.
- With no root flag it searches this Repository Root's folder first and, only when nothing matches
  there, every folder under `sessions/`. A match found elsewhere opens the Session in its header
  `repoRoot`, which becomes the process's Repository Root; §6.6's rule that the root never changes
  within a process still holds.
- With `--repo-root` or `--worktree <name>` it searches only that root. A Session that exists only
  under another root exits 2 and names that root.
- An ambiguous prefix, judged within the scope that matched, exits 2 and lists up to 5 candidates
  (short id, name, root, last activity). No match exits 2: "No Session 1a2b in any Repository Root",
  or "No Session 1a2b in ~/shop" with a root flag.
- A held Session gets §5.6's refusal, and a gone `repoRoot` gets §6.10's.

#### 9.3 `--continue`

- It opens the newest Session by last activity (§4.12) in the picked root.
- It exits 2 before the TUI draws when there is none ("No Session to continue in ~/shop") and when
  the newest is damaged or newer ("The latest Session, "fix login redirect", is damaged. Use
  --resume to pick another."), as §5.6 does for a held one.
- A newest Session cut off by a crash resumes normally (§4.8).

#### 9.4 `--resume`

- It starts a new Session as a plain start does, with its lock and startup notices, and opens the
  TUI with the Session picker showing, as Ctrl+R does.
- Enter resumes through `session.resume`, taking the new lock first (§5.5). Esc leaves the picker
  into the new Session, which has no file yet. An empty root shows an empty picker.

#### 9.5 The model follows the Session

- Given `--provider` and `--model` always win. When they are omitted:
  - a resume (`--continue`, `--session`) uses that Session's model (§4.11);
  - a new Session, `--resume`'s included, or a resumed Session with no Model Turn, uses the model of
    the newest Session with a Model Turn in the Repository Root, newest by last activity;
  - in a Worktree whose root has none, the starting checkout's Repository Root is searched next;
  - otherwise Coding Agent exits 2: "No model: pass --provider and --model". A default model from a
    later configuration file slots in before this step.
- Wherever it came from, the model passes today's checks: it is known to the Provider Directory
  (Group 3's registry once it exists) and its credential is set. A failure exits 2 and says where
  the model came from: "anthropic/claude-x, the model of Session "fix login redirect", is not a
  known model".
- Order: pick the root, take the lock, read the file, then resolve and check the model. A failed
  check releases the lock before exit 2.
- An empty command line therefore starts the interactive path when a model is found.
- In the TUI, Ctrl+N keeps the current Session's model. Ctrl+R takes the picked Session's model, and
  keeps the current one with a Session notice when the picked Session has none or its model fails
  the checks.
- No notice says where the model came from; the frame's top line shows it.

#### 9.6 `coding-agent sessions`

- A second command word beside `run`. `--worktree <name>` reads that Worktree's list without
  creating or recreating it; with its folder gone it exits 2: "No worktree <name>". There is no
  `--all` in stage 1.
- It is read-only: it reads locks as §5.7 does and never takes or deletes one.
- It prints to stdout and exits 0. The first line names the root, and a missing or empty sessions
  folder prints "No Sessions in ~/shop". A folder it cannot read exits 2 with the error. Usage
  errors exit 2, internal errors 70.
- The table lists the newest first:

```text
Sessions in ~/shop
ID        ACTIVE   TASKS  MODEL                        STATUS                    NAME
1a2b3c4d  2h ago   3      anthropic/claude-sonnet-5-5                            fix login redirect
9f8e7d6c  1d ago   1      google/gemini-3-pro          open elsewhere (PID 4242) add retry to fetch
5a6b7c8d  3d ago   -      openai/gpt-5                 damaged                   refactor auth
0c1d2e3f  5d ago   -      -                            newer                     -
```

- ID is the first 8 characters, enough for `--session`. ACTIVE is a relative time, as in the picker.
  MODEL is the Session's model (§4.11).
- STATUS is empty for a free Session, else `interrupted`, `open elsewhere (PID 4242)` (or
  `(PID 4242 on build-01)` for another host), `damaged` or `newer`. `current` never appears, since
  this process holds no Session.
- A damaged row shows what was read before the bad line, with no task count. A newer row shows only
  the id and the file's mtime. NAME is cut to the terminal width only when stdout is a TTY.
- `--json` prints the `ok` payload of `session.list`, `{ root, sessions }`, plus `schemaVersion: 1`:
  full ids, `lastActivity` in epoch ms and §7.6's status objects. An empty root gives
  `"sessions": []`.

#### 9.7 Resume line on exit

- After the TUI closes, when the Session has a file, Coding Agent prints to stdout:
  `Session "fix login redirect" saved. Resume: coding-agent --session 1a2b3c4d`. With §9.2 and §9.5
  the command works as it stands from any folder.
- In a process started with `--worktree`, only §6.8's line prints. A removed Worktree prints no
  resume line, since its root is gone.

#### 9.8 Worktrees opened without `--worktree`

- Worktree behaviour (§6.8's cleanup and §6.11's notices) applies only to a process started with
  `--worktree`. Opening a Worktree's Session with `--session <id>`, or starting inside the Worktree,
  treats it as a plain Repository Root that this process never removes.
- Every opener whose Repository Root lies under `<CODING_AGENT_HOME>/worktrees/` still waits on a
  removal guard (§6.9), so a `--session` open cannot land in a Worktree another process is removing.

### 10. Tests

- Agent Core, with fake ports: I1 to I4, Closing Tool Results, Outcome Notes, a throwing
  `TranscriptWording` and `SteerSource`, `steer_taken`'s place in each of its four orders, and a
  Candidate Completion with a Steer waiting, below and at a Run Limit (ADR 0002 §8), and a
  cancellation between `assistant_message_completed` and the first `tool_call_queued`. For every run
  in the suite, `transcriptFromRunEvents` equals `snapshot().transcript.slice(carriedMessages)`.
- Unit tests of the pure decisions: the held-or-stale rule (§5.3) with injected probes; the Worktree
  name rule and generated names; §6.5's case and §6.8's keep-or-remove decision over injected git
  facts; the flag parser's usage errors; `--session` matching (scope order, full id over prefix,
  ambiguity) and §9.5's model choice over listing facts; and the `sessions` table and `--json` from
  fixed list entries.
- Real processes, files and git in `packages/coding-agent/tests`, with `CODING_AGENT_HOME` in a
  temporary folder, on Linux and Windows per pull request and on macOS after merge:
  - N Bun processes racing for one Session lock produce exactly one winner; a holder killed with
    SIGKILL leaves a lock that is judged stale and taken over; two reclaimers racing on one stale
    lock produce one winner; `kill(pid, 0)` reports `ESRCH` for a reaped child; SIGHUP releases the
    lock, on Linux and macOS only, with `skipIf` on Windows, where a test cannot raise SIGHUP in
    another process;
  - Worktrees in temporary repositories: create, reopen, and recreate from a kept branch; the
    refusals outside git, with no commits and for a missing §6.6 subfolder; `.worktreeinclude` with
    anchored and unanchored patterns, symbolic links skipped on both sides, and no overwrite; each
    keep reason, and a removal that loses nothing; the guard against an opener racing a removal; and
    a `post-checkout` hook that sees no provider credential;
  - `--session` across two roots, the `--continue` refusals, and `sessions` on a damaged and a newer
    file;
  - a Session file cut right after an `assistant_message_completed` with Tool Calls, which resumes
    with each call closed (§4.8).
- Mode checks skip with `noModeBits` on Windows. Symbolic-link cases run on all three OSes, as the
  Tools tests do.
- A type-level test in `coding-agent` checks that the controller's Actions are assignable to
  `TuiActions`. `tui` tests pass `keySet` and `hints` explicitly.
- End-to-end tests on recorded fixtures cover two terminals on one Session, and Worktrees. They run
  on the existing harness in `packages/coding-agent/tests/support` (`record-provider.ts`,
  `replay-provider.ts`, `fake-tui.ts`), and the scenarios to record are chosen with the build
  tickets.

### 11. Out of scope

- Compaction: Group 1's next stage, waiting on Group 3's items 6 and 7.
- Background Sessions, and switching Session while a Coding Task runs.
- Slash commands: Group 2's router binds `/new` to `session.new` and `/resume` to the Session
  picker once it exists.
- A footer.
- A limit across a whole Session.
- Sessions in `coding-agent run`: headless keeps one Coding Task, no Prompt Queue and no Session
  file.
- Session retention: nothing deletes old Session files until a settings file exists.
- Remote clients, with their reconnect protocol (a snapshot plus numbered updates) and a lock per
  client.
- `--no-session` and `coding-agent sessions --all`: no stage 1 feature needs them, tests isolate
  their files with `CODING_AGENT_HOME`, and adding them later changes no file format.
- Branching a Session, renaming a Session, a takeover flag for a held lock, and a sweep of stale
  locks or Worktrees.

### 12. Amendments

On 2026-11-26, [CDA-130](https://datn-fit-hcmus.atlassian.net/browse/CDA-130) amended this record:

- **Session Usage** (§7.2): `ControllerState.session` gains `usage?: SessionUsage`,
  `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens?, costUsd? }`. The Session
  Controller adds each appended `model_turn_completed` with the shared turn-cost rule
  (`totalFromProvider ?? total`; a Model Turn with tokens and no cost makes the cost unknown) and
  sends a `state` update. When a Session opens, it sums the Session file's `model_turn_completed`
  events into the `opened` state. It never reads `run_settled` usage. `usage` absent means no Model
  Turn has completed; `costUsd` absent means the cost is unknown, not zero. The naming request
  (§4.10) is not counted.
- **TUI** (§8.1): `TuiModel.session` mirrors the field. The adapter maps it with the other
  `session` fields, and `projectSessionLogEntry` does not sum usage.

## Considered options

- **A `steer` command that pushes Steers into the Agent Run**, as the proposal named it. A pushed
  Steer has two copies, and edit and delete would need `withdraw` and `replace` commands that can
  lose a race with the turn boundary. A boundary event answered by a reply would add a protocol and
  a timeout to every Model Turn. Rejected for the pull port (§3.2).
- **Telling the model that Steers are waiting.** A count without the content gives it nothing to act
  on, and a note would add text and a Run Event to every Model Turn.
- **Carrying a Steer on `model_turn_started`**, which merges two facts and makes that event change
  the Transcript; and **continuing after a `succeeded` Verification** to take a Steer, which leaves
  runs whose Verification succeeded but which do not settle.
- **Steers left at settlement put back in the Prompt** (Pi's Esc, which loses ids and kinds),
  started whatever the outcome, or dropped. Rejected for head Follow-ups (§3.4).
- **Edit as withdraw-and-resubmit**, which is what `queue.dequeue` already does for every item and
  loses the item's place.
- **The Prompt Queue saved in the Session file** and restored on resume, as OpenCode does with a
  server and a database: a record for every enqueue, edit, delete and take. Discarding without a
  count, as Pi, Codex and Gemini CLI do, suits queues that exist only during a run.
- **Pi-style message entries in the Session file**, which lose Approvals, Verification runs and the
  Steer marker unless each gets its own type, and need timestamps our messages lack; or both shapes
  side by side, which doubles what must be versioned.
- **Pi's folder encoding** (`/a-b/c` and `/a/b-c` collide, and it grows with the path), **UUIDv7
  ids** (short prefixes of Sessions made minutes apart collide), and **a folder inside the
  repository** (it needs an ignore rule and goes with the working tree).
- **Other locks**: a directory lock with an mtime heartbeat (a live holder can lose it after a
  suspend, and every process needs a timer), a kernel lock through `bun:ffi` (experimental, three
  code paths), a presence socket (the socket file survives a crash on POSIX, so it needs the same
  probe), `link` publishing (ReFS, so Dev Drive, has no hard links), and takeover by plain delete
  and create (two reclaimers can both win).
- **`--continue` on a held Session opening the newest free Session or a new one**, which lands the
  person in a Session they did not ask for.
- **For another Coding Agent on the same root**: a confirmation, which blocks an allowed case; a
  per-instance registry, whose dead markers pile up; and an exclusive per-directory lock, which a
  third instance does not see once the first exits.
- **Worktrees inside the repository** (Claude Code's `.claude/worktrees/` shape): `git status` lists
  them, the main checkout's Path Jail contains them, and `grep -r` and `find` walk them. A sibling
  folder writes into a parent folder the person never chose.
- **A Worktree based on the remote default branch after a fetch** (Claude Code's default), and the
  branch names `worktree-<name>` or the bare name, which collides with the person's branches.
- **Claude Code's keep-or-remove prompt at exit**, whose "remove anyway" deletes work; always
  keeping, which piles up empty Worktrees; and testing that the branch tip is still the starting
  commit, which needs that commit stored and keeps a merged branch.
- **Filing a Worktree's Sessions in the repository's folder.** Picking one from the main checkout
  would either move a running process to another Repository Root or only print a command.
- **The TUI deciding** whatever `TuiModel` shows, or **Coding Agent deciding everything**, modes
  included. Rejected for §7.1's split, as Pi shares one `AgentSession` core among its interactive,
  print and RPC modes.
- **`void` handlers** with every answer coming back through the model, which still needs a second
  channel for Actions that finish later; and **the client confirming while the controller discards
  whatever waits**, which lets a stale view discard more than the person agreed to.
- **Starting every process in a new Session and then sending `session.resume`**, which briefly locks
  a throwaway Session that §5.8's notice would show to other terminals.
- **A new Session when `--continue` finds nothing**, as Pi does, and **Pi's picker before any
  Session exists**, which needs a picker that runs without a Session Controller.

## Consequences

- **Amended records**, each with a dated note:
  - ADR 0001 §7: non-inheritance covers the git commands started for a Worktree (§6.12).
  - ADR 0002 §8: the Transcript an Agent Run starts from, invariants I1 to I4, Closing Tool Results,
    Outcome Notes, `carriedMessages`, the `SteerSource` port, `steer_taken`, a Candidate Completion
    with a Steer waiting, and Run Events as persistent data in the Session file.
  - ADR 0003 §5: the system prompt is built once per Session and stored; its sentences about Coding
    Tasks arriving one at a time, `<task_outcome>` and Steers; and memory as the Session's
    Transcript.
  - ADR 0004 §10: `openAgentRun`'s new fields and ports, twenty Run Event types,
    `transcriptFromRunEvents`, the Google signature rule, the `tui` surface, what Coding Agent owns,
    the interactive command line, and the check of the new names against Pi.
- ADR 0005 is unchanged. Headless passes no Transcript and no `SteerSource`, so its runs start with
  `carriedMessages: 0` and never take a Steer. `events.jsonl` keeps `schemaVersion: 2`: its lines
  gain only payload fields (`carriedMessages`, an Outcome Note on an unsuccessful `run_settled`, and
  a Closing Tool Result on a `tool_call_completed` that had none), and the adapter reads only the
  fields it knows.
- Agent Core gains a config field, two ports, one Run Event and one pure function, and still knows
  nothing of Sessions, locks, files or Worktrees. Coding Agent grows the most: the Session, its
  Prompt Queue, Session file, Session lock and Worktrees, and the Session Controller.
- Groups 2 and 3 work against the Session Controller rather than the TUI. Group 2's router binds
  `/new` and `/resume`; Group 3's keybindings (item 17) replace the key table through `renderTui`;
  Group 3's usage schema ([CDA-127](https://datn-fit-hcmus.atlassian.net/browse/CDA-127)) reaches
  the Session file on `model_turn_completed` and `run_settled`.
- The build tickets are cut into [Build Stage 1: multi-prompt conversation and session
  resume](https://datn-fit-hcmus.atlassian.net/browse/CDA-146) from this record.
- Costs accepted: a Session file that grows with every Run Event and is never trimmed; liveness
  judged from PIDs and boot times rather than an OS lock, with a reused PID that needs a person to
  delete a file; a removal guard that can make an opener wait; Worktrees and locks that a crash
  leaves behind with no sweep; and Follow-ups that a Quit, a signal or a crash discards.
