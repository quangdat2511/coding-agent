# Pi steering and follow-up queue research

## Snapshot and scope

Research snapshot: **2026-11-23**. The Pi repository tip used here is
[`69a6993486acee850d14a4a1547daa4a167228ad`](https://github.com/earendil-works/pi/commit/69a6993486acee850d14a4a1547daa4a167228ad),
the `main` commit titled `fix(ai): replay Responses tool calls with status "completed"`, dated
2026-11-22. Package metadata at this commit reports version `1.6.0` for `pi-agent-core`,
`pi-coding-agent`, `pi-tui` and `pi-durable`
([agent metadata](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/package.json),
[coding-agent metadata](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/package.json)).

This note uses only Pi's source, tests, and in-repository documentation. It feeds
[CDA-139](https://datn-fit-hcmus.atlassian.net/browse/CDA-139) "Decide where Steers wait and how
an Agent Run takes them" and does not decide it.

Drift since the [Pi architecture research](pi-architecture.md) (pinned at `9841914c`): the queue
methods in `agent.ts` moved down about 25 lines (the ticket's `agent.ts:308-393` matches the new
commit), `shouldStopAfterTurn` was replaced by `finishTurn`, `peekQueuedMessages` was added, and
the durable harness that note cites under `packages/agent/src/harness` now lives in its own
`packages/durable` package (commit `080160162`, "feat(durable): move Pico into dedicated
package"). The steering and follow-up semantics themselves are unchanged between the two commits.

## Question

How do Pi's steering and follow-up queues behave end to end: where queued messages wait, when a
steering message is delivered relative to the current turn and its tool calls, what happens when
the agent is about to stop with steering pending, what abort does to both queues, how a queued
message is removed, and how the interactive mode shows the queue and binds its keys?

## Short answer

- **Where they wait.** The authoritative queues are two in-memory arrays inside agent-core's
  stateful `Agent`, not in the low-level loop. The loop only pulls, through the
  `getSteeringMessages` and `getFollowUpMessages` callbacks that `Agent` implements by draining
  its queues. The coding agent's `AgentSession` keeps a second, text-only mirror of both queues
  for display, and the interactive mode keeps a third queue for input typed during compaction.
- **When a steer lands.** After the current assistant turn and all of its tool calls finish,
  before the next model request. Tool calls are never skipped. `steeringMode` picks one message
  per poll (`"one-at-a-time"`, the default) or the whole queue (`"all"`); `followUpMode` does the
  same for follow-ups.
- **About to stop.** A response with no tool calls still polls steering first. A pending steer
  keeps the same run going for another turn; follow-ups are polled only when there is no tool
  call and no steer. The session-level settle boundary runs only after both queues are empty.
- **Abort.** `Agent.abort()` and `AgentSession.abort()` leave both queues untouched. The
  interactive Esc clears both queues and puts their text back in the editor before aborting; RPC
  clients must send `clear_queue` before `abort` to get the same effect.
- **Removal.** There are no message IDs and no single-item delete or edit. A message leaves the
  queue when the loop drains it (the display mirror drops it by matching its text) or when a
  caller clears everything. The interactive Alt+Up (Alt+Q on Windows and WSL) clears both queues
  into the editor as one draft.
- **Contrast.** Pi's separate `pi-durable` harness, which the CLI does not use, gives each queued
  input a submission ID that can be withdrawn while still queued, withdraws queued inputs on
  abort by default, and starts a follow-up as a successor run instead of continuing the current
  one.

## Findings

### 1. Where queued messages wait

**Agent-core `Agent` owns the queues.** `PendingMessageQueue` is a private array of
`AgentMessage` with `enqueue`, `peek`, `drain` and `clear`; `drain` removes what `peek` selects,
which is the first item in `"one-at-a-time"` mode and every item in `"all"` mode
([PendingMessageQueue](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L149-L180)).
`Agent` holds one steering and one follow-up queue, both defaulting to `"one-at-a-time"`
([fields](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L194-L198),
[constructor defaults](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L255-L256)).
`steer()` and `followUp()` only enqueue; the other public queue methods are three `clear*`
methods, `hasQueuedMessages()` and a non-consuming `peekQueuedMessages()`
([queue API](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L307-L342)).
`prompt()` and `continue()` throw while a run is active and point callers at `steer()` or
`followUp()`
([prompt guard](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L379-L395)).

**The loop pulls through two callbacks.** `AgentLoopConfig` declares `getSteeringMessages` and
`getFollowUpMessages` as async, must-not-throw callbacks that return `[]` when nothing is queued
([callback contract](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/types.ts#L282-L306)).
`Agent.createLoopConfig` implements them as `steeringQueue.drain()` and `followUpQueue.drain()`
([wiring](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L506-L513)).
So `runAgentLoop` holds no queue: it is a pull port, and the stateful `Agent` that outlives each
run is the queue owner.

**The coding agent mirrors the queues as text.** `AgentSession` keeps `_steeringMessages` and
`_followUpMessages` as `string[]`, commented as tracking pending messages "for UI display"
([mirror fields](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L425-L430)).
Queueing pushes the text to the mirror, emits `queue_update`, builds a plain `role: "user"`
message and calls `agent.steer()` or `agent.followUp()`
([`_queueSteer` and `_queueFollowUp`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2402-L2430)).
`prompt()` during a run requires `streamingBehavior: "steer" | "followUp"` and rejects without it
([streaming branch](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2241-L2255)).
Extension custom messages can also be sent with `deliverAs: "steer" | "followUp"`; these go
straight to `agent.steer()` or `agent.followUp()` and never enter the text mirror
([sendCustomMessage](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2488-L2495)).

**The interactive mode has a third queue during compaction.** While the session compacts, Enter
and the follow-up key push `{ text, mode }` into `compactionQueuedMessages` instead of the
session. When compaction ends, the first non-command message starts a prompt and the rest are
re-queued as steers or follow-ups
([compaction queue](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L5007-L5100)).

### 2. When a steer is delivered

The main loop is `runLoop`. Its inner loop runs while there are tool calls to answer or pending
messages; its outer loop exists only to pick up follow-ups
([runLoop](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L172-L330)).
Steering is polled at three points:

1. **At run start**, before the first request, for input typed while the run was starting
   ([initial poll](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L184-L185)).
   For `prompt()`, the prompt messages are emitted first, so a steer polled here follows the new
   prompt in the first request
   ([prompt emission](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L126-L133)).
2. **After each turn**, once the assistant message is streamed, every tool call has a result,
   `finishTurn` has run and `turn_end` is emitted
   ([tool batch and poll](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L267-L307)).
3. **After `prepareNextTurn`** (for example compaction), but only if the previous poll returned
   nothing, so `"one-at-a-time"` never delivers two messages into one turn
   ([catch-up poll](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L210-L216)).

Polled messages are emitted (`message_start`, `message_end`) and appended to the context before
`prepareRequest` and the next provider request
([injection](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L219-L226)).
Tool execution, sequential or parallel, never polls steering; the parallel path awaits every call
before it emits results in call order
([parallel execution](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L592-L660)).
The type docs say tool calls "are not skipped"
([types](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/types.ts#L282-L293)),
and the agent README lists the same order: tools finish, steering is injected, the model answers
([README](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/README.md#L390-L427)).
This was a deliberate change: the original split into `steer()` and `followUp()` skipped the
remaining tool calls, and release 0.58.4 made steering wait for the whole batch
([original semantics](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/CHANGELOG.md#L763-L767),
[0.58.4 fix](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/CHANGELOG.md#L529-L533)).
The loop test "should inject queued messages after all tool calls complete" covers it
([test](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/test/agent-loop.test.ts#L815)).

**Mode options.** `QueueMode` is `"all" | "one-at-a-time"`
([type](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/types.ts#L55)).
In the coding agent both modes are user settings, `steeringMode` and `followUpMode`, defaulting
to `"one-at-a-time"`
([settings doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/settings.md#L31-L32)),
editable in `/settings`, where the descriptions read "deliver one, wait for response" and
"deliver all at once"
([settings selector](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/components/settings-selector.ts#L494-L507)),
and synced to the `Agent` by `AgentSession`
([mode setters](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2865-L2886)).
With the default, the steering poll after each turn takes at most one message, so a queue of N
steers is delivered over N turns, each answered before the next is injected.

**`finishTurn` can skip the poll.** A `finishTurn` hook that returns `{ action: "end" }` ends the
run after `turn_end` without polling either queue, and the queues are kept
([README](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/README.md#L136-L146),
[test "keeps queues when finishTurn ends the run"](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/test/agent.test.ts#L1109)).

### 3. About to stop with steering pending

A response without tool calls sets `hasMoreToolCalls = false`, but the loop still polls steering
right after `turn_end`. If a steer is returned, the inner loop's condition
`hasMoreToolCalls || pendingMessages.length > 0` holds and another turn runs with the steer in
context. Only when that poll is empty does the loop reach "Agent would stop here" and poll
follow-ups; a returned follow-up becomes the pending input of another inner-loop pass in the
same run
([stop check](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L303-L329)).
The test "keeps steering ahead of follow-up from a non-assistant continuation tail" pins the
priority
([test](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/test/agent.test.ts#L1043)).

The coding agent adds a second safety net for messages that arrive after the loop's last poll.
`_startRun` loops after `agent.prompt()`: `_handlePostAgentRun` returns `hasQueuedMessages()`,
and on `true` the session calls `agent.continue()`
([run loop](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L1983-L2002),
[post-run check](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2064-L2100)).
Because the transcript then ends in an assistant message, `Agent.continue()` drains one steering
batch first (skipping the initial poll so `"one-at-a-time"` still delivers one), then one
follow-up batch
([continue](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L392-L420)).
Only when both queues are empty does the session run the extension boundary
`agent_before_settle`; if that boundary leaves a queued message, the session continues again
instead of settling
([settle boundary](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2102-L2122)).
In short, a pending steer always wins over stopping, and over the last pre-settle hook.

### 4. What abort does to the queues

**Agent-core.** `Agent.abort()` only aborts the active run's `AbortController`; it does not touch
either queue. Only `reset()` (refused during a run) and the `clear*` methods empty them
([abort and reset](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L349-L377)).
An aborted or failed response is a hard exit: the loop emits `turn_end` and `agent_end` and
returns without polling either queue
([hard exit](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L254-L265)).
The loop has no abort check of its own between a tool batch and the steering poll, so when an
abort lands while tools run, the batch is answered (unstarted calls get an "Operation aborted"
result), the poll still runs, and one queued steer can be appended to the transcript before the
next request ends as aborted. Provider adapters report an aborted signal as `stopReason:
"aborted"`
([tool batch and poll](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent-loop.ts#L267-L307),
[Anthropic adapter](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/ai/src/api/anthropic-messages.ts#L1169)).
This is a reading of the code, not an observed run.

**Coding agent.** `AgentSession.abort()` sets `_agentRunAbortRequested`, aborts retry, compaction
and branch summary, calls `agent.abort()` and waits for idle; it does not clear the queues
([session abort](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2613-L2625)).
The post-run loop stops on that flag
([run loop](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L1983-L2002)).
Whatever is still queued stays in the `Agent` and is taken by the next run: steering at its
initial poll, follow-ups when it would stop.

**Interactive mode.** Esc while streaming calls `restoreQueuedMessagesToEditor({ abort: true })`:
it clears all three queues, writes their text into the editor (steers first, then follow-ups,
joined by blank lines, ahead of any draft already in the editor), and then calls
`session.abort()`
([Esc handler](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3261-L3263),
[restore](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4986-L5005)).
Extension-triggered aborts take the same path
([extension abort handler](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2148-L2152)).
The user docs summarize this as "Aborting returns queued messages to the editor"
([usage](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/usage.md#L28-L40)).
While compaction or an auto-retry runs, Esc is rebound to abort only that operation
([compaction Esc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3866-L3874),
[retry Esc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3938-L3943)).

**RPC.** `abort` and `clear_queue` are separate commands. The RPC doc tells clients to send
`clear_queue` before `abort` to reproduce Esc, and adds that `abort` "continues queued messages
when they remain in the session"
([RPC doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/rpc-commands.md#L107-L128),
[RPC handlers](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L447-L454)).

### 5. How a queued message is removed

- **By delivery.** `drain()` removes the selected messages from the `Agent` queue. On the
  matching `message_start` of a user message, `AgentSession` removes the first entry with the
  same text from the steering mirror, or else from the follow-up mirror, and emits
  `queue_update` before listeners see the event
  ([delivery removal](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L1185-L1202)).
  The two copies are kept in step by text equality, not by identity or ID.
- **By clearing everything.** `Agent.clearSteeringQueue()`, `clearFollowUpQueue()` and
  `clearAllQueues()` drop agent-side messages
  ([Agent clear](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/agent/src/agent.ts#L317-L331)).
  `AgentSession.clearQueue()` empties both mirrors and both agent queues and returns the texts
  ([session clearQueue](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2580-L2607)).
- **By restoring to the editor.** The dequeue action calls `restoreQueuedMessagesToEditor()`
  without abort and reports how many messages it restored
  ([dequeue](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4747-L4754)).
  It is all-or-nothing, and the restored draft no longer records which part was a steer and which
  a follow-up.

There is no API in the CLI path to delete, edit or reorder one queued message, and queued
messages carry no ID.

### 6. Interactive display and key bindings

**Display.** `updatePendingMessagesDisplay` rebuilds a `pendingMessagesContainer` on each
`queue_update` and after each submit: one dim, truncated line per item, `Steering: <text>` for
steers and then `Follow-up: <text>` for follow-ups (compaction-queue items included), followed by
a hint naming the dequeue key "to edit all queued messages"
([display](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4931-L4984),
[queue_update handler](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3630-L3633)).
The container sits between the transcript and the status line, above the editor
([layout](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1074-L1082)).
The same `queue_update` event, with both complete queues, is part of the JSON event stream
([json events](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/json.md#L121)).

**Bindings.**

| Key (macOS, Linux) | Windows and WSL | Action id | Behavior |
| --- | --- | --- | --- |
| Enter | Enter | `tui.input.submit` | Idle: start a prompt. Streaming: `session.prompt(text, { streamingBehavior: "steer" })`. Compacting: queue as steer in the compaction queue. |
| Alt+Enter | Ctrl+Q | `app.message.followUp` | Streaming: queue a follow-up. Idle: same as Enter. Compacting: queue as follow-up in the compaction queue. |
| Alt+Up | Alt+Q | `app.message.dequeue` | Move every queued message back into the editor, without aborting. |
| Esc | Esc | `app.interrupt` | Streaming: restore every queued message to the editor, then abort. During compaction or auto-retry: abort only that. |

Sources: the default key table, where Windows defaults apply on `win32` and on Linux when
`WSL_DISTRO_NAME` or `WSL_INTEROP` is set
([app keybindings](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/keybindings.ts#L16-L74));
Enter as `tui.input.submit`, with Shift+Enter and Ctrl+J inserting a newline
([TUI keybindings](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/tui/src/keybindings.ts#L143-L144));
the submit handler's streaming branch
([submit](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3555-L3576));
the follow-up handler
([follow-up](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4715-L4745));
the action wiring
([setupKeyHandlers](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3258-L3308));
the editor, which routes `app.interrupt` to the Esc handler unless autocomplete is open
([custom editor](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/components/custom-editor.ts#L112-L125));
and the keybinding reference
([keybindings doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/keybindings.md#L162-L167)).
The Windows fallback exists because Windows Terminal binds Alt+Enter to fullscreen
([terminal setup](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/terminal-setup.md#L186-L190)).
The startup help lists the follow-up and dequeue keys
([help hints](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1139-L1140)).

### 7. Contrast: the durable harness inbox

`pi-durable` is a separate harness; the coding agent depends on `pi-agent-core`, not on it
([coding-agent metadata](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/package.json)).
Its queue design differs on every point CDA-139 cares about:

- Queued inputs wait in a per-conversation `pi.inbox` document as items with a `SubmissionId`,
  a mode (`steer`, `followUp`, or an entry `write`), and an optional `onAbort: "keep"`
  ([InboxItem](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/durable/src/harness/inbox.ts#L8-L32)).
- Boundaries pull: `postTools` places the first or all steers, `final` also places follow-ups,
  with the same two queue modes
  ([applyBoundary](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/durable/src/harness/inbox.ts#L73-L123),
  [spec table](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/durable/docs/spec.md#L3251-L3260)).
- At `final`, selected items "start one successor generation with those IDs as the new run's
  inputs", so a follow-up, or a steer that arrives at the end, becomes a new run, and items
  queued while after-run hooks run wait because "there is no next model request in the run"
  ([spec final boundary](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/durable/docs/spec.md#L3290-L3308)).
- `Submission.abort()` withdraws one queued item by ID and answers `already_placed` once a
  boundary has taken it; `Conversation.abort()` withdraws queued steers and follow-ups unless
  they were submitted with `onAbort: "keep"`
  ([withdraw by ID](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/durable/src/harness/submissions.ts#L147-L160),
  [abort withdrawal](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/durable/src/harness/inbox.ts#L162-L200),
  [spec](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/durable/docs/spec.md#L3238-L3249)).

There is no edit operation here either; an edit would be a withdraw followed by a new submission.

## Implications for CDA-139

The planned design (not decided): each prompt runs a new Agent Run seeded with the Session's
transcript; Coding Agent holds a Prompt Queue of Steers and Follow-ups; any queued prompt can be
sent now, edited or deleted by ID; a Steer is delivered after the current Model Turn's Tool
Calls, one per Model Turn; an unread Steer at a Candidate Completion continues the run instead of
entering Verification; a Follow-up becomes a new Coding Task in a new Agent Run.

### Where Pi maps onto the plan

- **Delivery point and rate.** Pi's default is the plan: after all Tool Calls of the turn, before
  the next request, one per turn. Pi makes the rate a setting (`"all"`); the plan fixes it.
- **Steer beats stopping.** Pi polls steering before it treats a tool-free response as the end,
  and runs its pre-settle hook only with empty queues. That is the plan's "continue instead of
  entering Verification", with Verification in the place of `agent_before_settle`.
- **The steer is an ordinary user message** appended after the tool results, so no new transcript
  role is needed.
- **Follow-ups as new runs** match `pi-durable`, not the CLI's `Agent`.
- **IDs, withdraw while queued, and "already taken"** match `pi-durable`'s submissions.

### Where Pi conflicts with the plan

- **Queue owner.** In Pi's CLI path the `Agent` that spans runs owns the queue, and the app keeps
  a text mirror synced by text equality. With a new Agent Run per prompt, a queue inside the run
  would die with it, and a mirror keyed by text cannot support edit or delete by ID.
- **Follow-up continues the run in Pi.** One `agent_end` and one settle cover the original prompt
  and its follow-ups. Under the plan each Follow-up gets its own Agent Run, Verification and
  Agent Result, so the Agent Run never sees Follow-ups.
- **Abort keeps queued items in Pi's `Agent`**, and the next run's start poll picks up leftover
  steers. Under the plan that cannot happen by accident, because a new Agent Run only sees what
  Coding Agent hands it, but the plan still has to say what abort does to the Prompt Queue.
- **No single-item edit or delete anywhere in Pi**; the closest is durable withdrawal by ID.

### Options for how an Agent Run takes Steers

**A. Pull port (Pi's loop callback shape).** Agent Core declares a port the run calls at two
points: after each Model Turn's Tool Calls, and before a Candidate Completion enters
Verification. Coding Agent implements it by removing at most one Steer from its Prompt Queue.

- Steers stay editable until the instant of the call; with one owner there is no mirror to sync.
- "Taken" is the port call itself; Coding Agent can mark the item and emit an event, and an edit
  or delete that loses the race gets a clear "already taken" answer, as in `pi-durable`.
- Agent Core gains a callback seam that must not throw (Pi's contract) and is easy to fake in
  tests. "Send now" means making the item next in line; it still waits for the next poll.
- The run cannot tell a Steer is waiting until it asks, so the "before Verification" check has to
  be an explicit second poll point, as Pi's stop check is.

**B. Pushed `steer` command (Pi's `Agent.steer()` shape).** Coding Agent calls
`run.steer(message)`; the Agent Run keeps pending Steers in Agent State and takes one per turn.

- Pending Steers become visible in Agent State and Session Events, and the run knows at once that
  one is waiting.
- Two copies exist (the run's and the Prompt Queue's). Edit and delete need extra commands
  (`withdraw`, `replace`) that can lose a race with the run's turn boundary, and the copies must
  be synced by ID, not by text as Pi does.
- To keep Steers editable, Coding Agent could push only when the run is about to need one, but
  that needs a "ready for a Steer" signal from the run, which turns the design back into A.

**C. Push at the boundary (hybrid).** The run emits a boundary event ("Tool Calls done", "about
to verify") and waits briefly for Coding Agent to answer with zero or one Steer.

- Keeps ownership in Coding Agent like A, but turns the call into an event and a reply, which
  adds a timeout or a protocol for "no Steer" on every Model Turn.

### Other choices CDA-139 has to make, with Pi's precedents

- **Abort.** Return queued Steers to the editor (Pi interactive), withdraw them (`pi-durable`
  default), or keep them for the next prompt (Pi `Agent`, `pi-durable` `onAbort: "keep"`).
  Keeping them means a later prompt silently carries an old Steer, as in Pi's `Agent`.
- **Steers queued during Verification or at the run's end.** Pi's CLI continues the same run;
  `pi-durable` starts a successor run when nothing in the run can take them. The plan has to
  pick one for a Steer that arrives after the last poll, and say whether a failed Verification's
  feedback and a Steer can share one Model Turn (Pi appends prepared messages, then steering, in
  one turn).
- **Steer at run start.** Pi delivers a steer typed while the run starts in the first request,
  after the prompt. With a new Agent Run per prompt this is the window between submitting and
  the first Model Turn.
- **Send now and edit.** Pi has no precedent for either. "Send now" for a Follow-up while a run
  is active means either promoting it to a Steer or aborting the run, which is a product choice.

## Open points the sources did not settle

- The RPC doc says `abort` "continues queued messages when they remain in the session". The code
  read here shows no automatic restart after an abort; leftover items wait for the next run. No
  Pi test covers abort with a non-empty queue, and nothing was run to check.
- The finding that an abort during tool execution can still move one steer into the transcript
  comes from reading `runLoop` and the provider adapters, not from a run. The interactive Esc
  never hits it, because it clears the queues before aborting.
- Pi never edits a queued message in place, so it offers no precedent for edit semantics beyond
  withdraw and resubmit.
