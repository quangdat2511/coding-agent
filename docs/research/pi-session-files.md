# Pi session files, storage location, and resume flags

## Snapshot and scope

Research snapshot: **2026-11-23**. The Pi repository tip used here is
[`69a6993486acee850d14a4a1547daa4a167228ad`](https://github.com/earendil-works/pi/commit/69a6993486acee850d14a4a1547daa4a167228ad),
the `main` commit titled `fix(ai): replay Responses tool calls with status "completed"`, dated
2026-11-22. Package metadata at this commit reports version `1.6.0` for `pi-coding-agent`
([`package.json`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/package.json#L3)).

This note uses only Pi's source and its own documentation. It feeds CDA-141 ("Decide the session
file schema, location, and how a resumed Session is redrawn") and compares Pi with this
repository's Agent Core transcript and Run Events. It does not decide anything for CDA-141.

[Pi architecture research](./pi-architecture.md) pinned the older commit `9841914c` (version
`0.85.0`). The session format kept the same header, version number (3), and 8-character entry IDs
since then, but code moved and grew: the persistence handler it cited at `agent-session.ts`
L642-L723 is now at
[L1215-L1238](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L1215-L1238),
the `usage` and `context_edit` entry types did not exist at `9841914c`, system messages are now
persisted, and the session file is now created at the first user message instead of the first
assistant message (commit `ff72faba2`, "save new session file at the first user message"). None
of these additions bumped the session version.

Terminology: CDA-147 renamed this repository's lifecycle of one prompt to Agent Run and its
observations to Run Events (`packages/agent-core/src/events.ts`), with Session meaning the
conversation the person sees. This note uses "Pi session" for Pi's concept and the current code
names for ours.

## Question

What does Pi write to a session file, and how does it find sessions again? Specifically: the JSONL
header and entry types (version, cwd, IDs, parent IDs and branching), when entries are appended,
how credentials are kept out, the storage directory and file name, how `--continue`, `--resume`,
`--session` and `--no-session` pick a session, how the resume list derives each session's name,
time and length, and how a resumed session is redrawn in the TUI.

## Short answer

- **Format.** One JSONL file per Pi session. Line 1 is a header
  `{type:"session", version:3, id, timestamp, cwd, parentSession?}`. Every later line is an entry
  with `type`, an 8-hex-character `id`, a `parentId` (null for a root), and an ISO `timestamp`.
  The `id`/`parentId` links form a tree; a `leaf` pointer kept in memory decides which branch is
  active. Entry types: `message`, `model_change`, `thinking_level_change`, `usage`, `compaction`,
  `branch_summary`, `custom`, `custom_message`, `context_edit`, `label`, `session_info`.
- **Appending.** Nothing is written until the session holds a user or assistant message; then the
  buffered entries are written at once and every later entry is appended synchronously, one line
  per entry. Messages are persisted on `message_end`, so streaming deltas never reach the file.
- **Credentials.** Pi keeps them out by construction, not by scrubbing: entries name the provider
  and model, while keys and OAuth tokens live in a separate `auth.json` written with mode `0600`
  and are resolved per request. Tool output, file contents, and prompts are stored verbatim.
- **Location.** `~/.pi/agent/sessions/--<encoded cwd>--/<ISO time>_<UUIDv7>.jsonl`, where the
  encoded cwd has its path separators replaced by `-`. Sessions are grouped by the exact working
  directory, not by repository.
- **Flags.** `--no-session` uses an in-memory session and wins over the other flags; `--continue`
  opens the newest file (by mtime) for the current directory or starts a new one; `--resume` opens
  a picker scoped to the current directory; `--session` takes a path, an exact ID, or an ID prefix,
  searching the current directory first and then all projects, and offers to fork a session found
  in another project.
- **List and redraw.** The picker shows the `session_info` name or else the first user message
  text, the age of the newest user or assistant message, and a count of every `message` entry in
  the file. A resumed session is redrawn from final messages on the active, compaction-aware branch:
  tool call components are rebuilt from assistant messages and paired with tool results by ID.

## 1. File format

### Header

The first line is a `SessionHeader`: `type: "session"`, an optional `version` (absent in v1
files), `id`, `timestamp`, `cwd`, and an optional `parentSession`
([`SessionHeader`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L41-L50)).
`newSession()` fills it with `CURRENT_SESSION_VERSION` (3), the session ID, an ISO timestamp, and
the resolved working directory
([`newSession`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1067-L1093)).
The header is metadata only and is not part of the entry tree
([format doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/session-format.md#L64-L76)).

- **Session ID.** By default a time-ordered UUIDv7
  ([`createSessionId`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L264-L266),
  [`uuidv7`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/ai/src/utils/uuid.ts#L7-L8)).
  `--session-id` or the SDK can supply one; it must be alphanumeric with `.`, `_`, `-` inside
  ([`assertValidSessionId`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L268-L274)).
  Pi's format doc says only "a UUID"; the code uses v7.
- **`cwd`.** Recorded once and never changed. Pi runs a resumed session in that directory, so
  tools and project configuration resolve from it
  ([sessions doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/sessions.md#L16-L22)).
- **`parentSession`.** The absolute file path (not the ID) of the session this one was forked or
  cloned from
  ([`forkFrom`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1867-L1875),
  [`createBranchedSession`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1695-L1702)).

### Entries, IDs, and the tree

Every entry extends `SessionEntryBase { type, id, parentId: string | null, timestamp }`
([`SessionEntryBase`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L57-L62)).
Entry IDs are the first 8 hex characters of a random UUID, checked against existing IDs, with a full
UUID as a fallback
([`generateId`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L276-L284)).
Entry timestamps are ISO strings; the nested message timestamp is Unix milliseconds
([format doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/session-format.md#L43-L47)).

Each append makes the new entry a child of the current leaf and moves the leaf to it
([`appendMessage`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1224-L1234),
[`_appendEntry`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1201-L1216)).
Branching only moves the leaf to an earlier entry, so the next append starts a sibling branch and no
history is rewritten
([`branch`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1593-L1604),
[class comment](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L986-L996)).
The leaf is not stored. On load it becomes the last entry in the file
([`_buildIndex`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1113-L1132)),
so the branch that was appended to most recently is the one a resume opens. The active branch is the
walk from the leaf back to the root
([`buildSessionPath`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L390-L416)).

User-facing branching comes in three forms: `/tree` moves within one file, `/fork` starts a new file
from an earlier user message, and `/clone` copies the active branch into a new file
([sessions doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/sessions.md#L36-L48)).
The copy keeps only the root-to-leaf path and re-chains `parentId` around dropped label entries
([`createBranchedSession`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1647-L1768)).

### Entry types

The union is defined in
[`SessionEntry`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L64-L194);
examples for each are in Pi's
[format doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/session-format.md#L62-L207).

| Type | Holds | In model context |
| --- | --- | --- |
| `message` | One `AgentMessage`: `system`, `user`, `assistant`, `toolResult`, or Pi's extra roles `bashExecution` and `custom` | Yes |
| `model_change` | `provider`, `modelId` | No, sets the restored model |
| `thinking_level_change` | `thinkingLevel` | No, sets the restored level |
| `usage` | Usage and cost of work that is not an assistant message, such as cache warming | No |
| `compaction` | `summary`, `firstKeptEntryId`, `tokensBefore`, optional `systemMessage` checkpoint, `details`, `usage` | Yes, as a summary |
| `branch_summary` | `fromId` (abandoned leaf) and an LLM summary of that branch | Yes, as a summary |
| `custom` | Extension state: `customType`, `data` | No |
| `custom_message` | Extension text or images, `display` flag | Yes |
| `context_edit` | `targetId` and a replacement content, or `null` to omit the target | Changes the target only |
| `label` | Bookmark `label` on `targetId` | No |
| `session_info` | Display `name` (latest wins, empty clears) | No |

System messages carry the prompt and tool loadout: the first request persists a full system
message, later requests persist patches (`sections`, `toolsAdded`, `toolsRemoved`), and replaying
them in order yields the current prompt and tools
([format doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/session-format.md#L78-L95),
[`SystemMessage`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/ai/src/types.ts#L560-L587)).
Assistant messages record `api`, `provider`, `model`, `usage`, `stopReason`, and a request-start
timestamp
([`AssistantMessage`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/ai/src/types.ts#L595-L626)).

Rebuilding model context walks the active branch, starts from the latest compaction entry when
there is one (summary, then kept entries from `firstKeptEntryId`, then everything after), and then
applies the latest `context_edit` per target
([`buildContextEntries`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L476-L514),
[`buildSessionProjection`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L546-L576)).
The restored model and thinking level are the last `model_change` (or assistant message model)
and `thinking_level_change` on that branch
([`getSessionContextSettings`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L418-L433)).

### Versions and migration

Version 1 was a linear list, version 2 added `id`/`parentId`, version 3 renamed the `hookMessage`
role to `custom`
([format doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/session-format.md#L22-L30)).
On load, older files are migrated in memory (v1 entries get generated IDs chained to the previous
entry) and the whole file is rewritten
([migrations](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L286-L347),
[`_loadEntries`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1095-L1111)).
New entry types were added within version 3. They stay readable by older code because context
building turns any type it does not recognize into no messages
([`sessionEntryToContextMessages`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L439-L466)).

The loader skips blank and malformed lines, returns nothing if the first parsed line is not a
header, and appends a newline when the file ends with a partial line
([`loadEntriesFromFile`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L619-L673)).

### Example

An illustrative file for one prompt that ran one tool, written in Pi's shapes (IDs and text are
invented; the system prompt and tool list are cut short):

```jsonl
{"type":"session","version":3,"id":"01a20779-07e5-7c3e-9a51-3b0e2f6d1a44","timestamp":"2026-11-23T08:15:02.117Z","cwd":"/home/dev/shop-api"}
{"type":"model_change","id":"3f9c1a2b","parentId":null,"timestamp":"2026-11-23T08:15:02.120Z","provider":"anthropic","modelId":"claude-sonnet-4-5"}
{"type":"thinking_level_change","id":"7d01e4c8","parentId":"3f9c1a2b","timestamp":"2026-11-23T08:15:02.121Z","thinkingLevel":"medium"}
{"type":"message","id":"a41b0c9e","parentId":"7d01e4c8","timestamp":"2026-11-23T08:15:09.401Z","message":{"role":"system","content":"","sections":{"preamble":"You are an expert coding assistant..."},"toolsAdded":[{"name":"bash","description":"...","parameters":{}}],"timestamp":1795421709400}}
{"type":"message","id":"c2e8f017","parentId":"a41b0c9e","timestamp":"2026-11-23T08:15:09.402Z","message":{"role":"user","content":"Fix the failing date test","timestamp":1795421709398}}
{"type":"message","id":"5b6d93a0","parentId":"c2e8f017","timestamp":"2026-11-23T08:15:12.905Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"toolu_01","name":"bash","arguments":{"command":"bun test date"}}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":1830,"output":64,"cacheRead":0,"cacheWrite":0,"totalTokens":1894,"cost":{"input":0.0055,"output":0.001,"cacheRead":0,"cacheWrite":0,"total":0.0065}},"stopReason":"toolUse","timestamp":1795421709410}}
{"type":"message","id":"e90a4c71","parentId":"5b6d93a0","timestamp":"2026-11-23T08:15:13.873Z","message":{"role":"toolResult","toolCallId":"toolu_01","toolName":"bash","content":[{"type":"text","text":"1 fail ..."}],"isError":false,"timestamp":1795421713871}}
{"type":"message","id":"0d4f2b96","parentId":"e90a4c71","timestamp":"2026-11-23T08:15:16.330Z","message":{"role":"assistant","content":[{"type":"text","text":"The test assumed UTC..."}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":2011,"output":48,"cacheRead":1830,"cacheWrite":0,"totalTokens":3889,"cost":{"input":0.006,"output":0.0007,"cacheRead":0.0005,"cacheWrite":0,"total":0.0072}},"stopReason":"stop","timestamp":1795421713880}}
{"type":"session_info","id":"9a7e1c3d","parentId":"0d4f2b96","timestamp":"2026-11-23T08:16:40.002Z","name":"Date test fix"}
```

It would be stored as
`~/.pi/agent/sessions/--home-dev-shop-api--/2026-11-23T08-15-02-117Z_01a20779-07e5-7c3e-9a51-3b0e2f6d1a44.jsonl`.
In the resume list it would show "Date test fix", a count of 5 (every `message` entry), and the age
of `1795421713880`, the newest user or assistant message timestamp.

## 2. When entries are appended

- **Session start.** For a new session the SDK appends a `model_change` and a
  `thinking_level_change`; for a resumed session without a thinking entry it appends one
  ([`sdk.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/sdk.ts#L442-L453)).
- **Messages.** On each `message_end` event, `AgentSession` appends `system`, `user`, `assistant`
  and `toolResult` messages as `message` entries and extension messages as `custom_message`
  entries
  ([persistence handler](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L1215-L1238)).
  `message_start`/`message_update` deltas, tool execution progress, and `agent_end` are not
  written. A `!` shell command from the user becomes a `bashExecution` message, deferred to the end
  of the run if the agent is streaming so tool calls and results stay adjacent
  ([bash messages](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L4066-L4108)).
- **Other actions.** Model and thinking level switches, compaction, `/tree` with summary, labels,
  `/name`, cache warming, and extension state each append their own entry
  ([`setSessionName`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L4113-L4121),
  [`setModel`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L2659-L2670)).

**Physical writes.** Until the session holds a user or assistant message, entries stay in memory,
so opening and closing Pi without chatting leaves no file. The first such message writes the
header and all buffered entries in one exclusive create (`wx`); after that each entry is one
`appendFileSync` call
([`_hasConversation` and `_persist`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1170-L1199)).
If a write throws, the entry is removed from memory again so no later entry can point at a parent
that is missing on disk
([`_appendEntry`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1201-L1216)).
`SessionManager` has no file locking, so nothing stops two processes from appending to the same
file.

## 3. How credentials are kept out

Pi has no redaction step in the session path. Credentials stay out because no persisted structure
carries them:

- Entries record only `provider` and `modelId`; the key, headers, and environment for a request are
  fetched from the model runtime per request and handed to the stream call, never to a message
  ([`_getRequiredRequestAuth`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/agent-session.ts#L569-L607)).
- Stored credentials live in `~/.pi/agent/auth.json`
  ([`getAuthPath`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/config.ts#L648-L651)),
  written with mode `0600` in a `0700` directory
  ([`auth-storage.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/auth-storage.ts#L37-L77)),
  and Pi's docs warn that this file holds keys and tokens
  ([providers doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/providers.md#L18)).
- On resume, the recorded model is used only if its provider still has configured auth; otherwise
  Pi falls back to another model
  ([model restore](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/sdk.ts#L223-L232)).

What is not protected: prompts, tool arguments, command output, and file contents are written
verbatim, and Pi's docs tell users to review exported or shared sessions for exactly that reason
([sessions doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/sessions.md#L72-L74)).
A secret printed by a tool lands in the file. The session directory and file are created without
an explicit mode, so their permissions follow the process umask, unlike `auth.json`
([`getDefaultSessionDir`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L599-L605),
[`_persist`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1182-L1199)).
The only redaction helpers found are for `/bug` reports, not session files
([`bug-report.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/bug-report.ts#L19-L63)).

## 4. Storage directory and file name

- **Root.** `~/.pi/agent/sessions`, where `~/.pi/agent` can be moved with `PI_CODING_AGENT_DIR`
  ([`getAgentDir`, `getSessionsDir`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/config.ts#L609-L676)).
- **Per-directory folder.** The resolved cwd with its leading separator removed and `/`, `\` and
  `:` replaced by `-`, wrapped in `--`, so `/home/dev/shop-api` becomes `--home-dev-shop-api--`
  ([`getDefaultSessionDirPath`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L588-L605)).
- **File name.** `<timestamp>_<session id>.jsonl`, where the timestamp is the header's UTC ISO
  time with `:` and `.` replaced by `-`, for example `2026-11-23T08-15-02-117Z_<uuid>.jsonl`
  ([`newSession`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1088-L1091),
  [format doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/session-format.md#L8-L14)).
- **Overrides.** `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then the `sessionDir` setting
  ([`main.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/main.ts#L733-L738)).
  A custom directory is flat, so lookups in it filter by the header `cwd`
  ([`list`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1919-L1940)).

Grouping is by exact working directory. Pi's session code has no notion of a git repository or
worktree: a subdirectory of a repository gets its own folder, and a linked worktree is simply
another directory (Pi's worktree handling is in context-file loading, not sessions;
[`resource-loader.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/resource-loader.ts#L236-L259)).
Deleting a session means deleting its file; the picker can do it with `Ctrl+D`, using `trash` when
available
([format doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/session-format.md#L16-L20)).

## 5. How the flags pick a session

`createSessionManager` checks the flags in a fixed order
([`createSessionManager`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/main.ts#L399-L490),
[help text](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/cli/args.ts#L308-L315)):

1. **`--no-session`** (also `--help` and `--list-models`): an in-memory session that never writes
   a file
   ([`inMemory`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1823-L1826)).
   It is checked first, so it silently overrides `--continue`, `--resume` and `--session`; only
   `--fork` rejects the combination
   ([`validateForkFlags`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/main.ts#L340-L354)).
2. **`--fork <path|id>`**: copies the session into a new file for the current directory.
3. **`--session <path|id>`**: an argument containing `/` or `\` or ending in `.jsonl` is a path.
   Otherwise Pi tries an exact ID in the current directory's folder (reading headers only), then an
   ID prefix there, then an exact or prefix match across all folders
   ([`resolveSessionPath`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/main.ts#L293-L324),
   [`findById`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1893-L1917)).
   A match from another project asks whether to fork it into the current directory; no match exits
   with an error. A path to a file that does not exist starts a new session at that path
   ([`_setSessionFile`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1039-L1065)).
4. **`--resume`**: opens the picker with "Current Folder" scope by default; `Tab` switches to all
   projects. Cancelling exits
   ([`selectSession`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/cli/session-picker.ts#L15-L58),
   [default scope](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/components/session-selector.ts#L737)).
5. **`--continue`**: the newest `.jsonl` by file mtime in the current directory's folder, or a new
   session if there is none
   ([`continueRecent`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1808-L1821),
   [`findMostRecentSession`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L752-L771)).
6. **`--session-id <id>`** without the above: opens that ID in the current folder or creates a new
   session with it. Otherwise a new session is created.

Opening a file takes the working directory from its header
([`open`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1780-L1806)).
So `--resume` and `--session` run the session where it was created, which can differ from where Pi
was started; `--continue` and forks use the current directory
([sessions doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/sessions.md#L16-L30)).
If that directory no longer exists, interactive mode offers to continue in the current directory
for this run only, fork into it, or cancel; other modes exit with an error
([`main.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/main.ts#L739-L763),
[`session-cwd.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-cwd.ts#L14-L56)).
On exit, interactive mode prints `pi --session <id>` (plus `--session-dir` when non-default) as the
resume command
([`formatResumeCommand`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L352-L364)).

## 6. How the resume list derives name, time, and length

`buildSessionInfo` streams every line of each file (ten files at a time) and derives
([`buildSessionInfo`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L802-L892),
[`SessionInfo`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L229-L243)):

- **Name.** The last `session_info` name in the file. Pi never generates one; it comes from `/name`,
  `--name`, or an extension
  ([format doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/session-format.md#L199-L207)).
  Without a name the row shows `firstMessage`, the text of the first user message in file order
  (whatever branch it is on), or "(no messages)". Control characters are replaced and the text is
  truncated to the row width
  ([row rendering](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/components/session-selector.ts#L473-L497)).
- **Time.** `modified` is the newest `message.timestamp` among user and assistant messages (for an
  assistant message that is the request start), falling back to the entry timestamp, then the
  header timestamp, then file mtime
  ([`getMessageActivityTime`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L788-L800)).
  It is shown as a relative age: `now`, `Nm`, `Nh`, `Nd`, `Nw`, `Nmo`, `Ny`
  ([`formatSessionDate`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/components/session-selector.ts#L25-L39)).
  `--continue` uses file mtime instead, so the two can disagree.
- **Length.** `messageCount` counts every `message` entry in the file: system messages, tool
  results, and messages on abandoned branches included. It is not a count of prompts.

The list is sorted by `modified`. The default "threaded" sort nests forks under their parent using
`parentSession`
([`buildSessionTree`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/components/session-selector.ts#L196-L244)).
Search matches the name, ID, cwd, and the joined text of all user and assistant messages
([`session-selector-search.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/components/session-selector-search.ts#L30-L104)).
In "all" scope the row also shows the session's cwd.

## 7. How a resumed session is redrawn

- **Agent state.** The SDK seeds the agent with `buildSessionContext()` messages (compaction and
  context edits applied) and restores model and thinking level from the branch
  ([`sdk.ts`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/sdk.ts#L209-L261),
  [initial state](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/sdk.ts#L403-L410)).
- **Chat.** At startup, after extensions bind, `renderInitialMessages()` renders
  `buildContextEntries()`, the active branch from the latest compaction onward
  ([startup](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1195-L1199),
  [`renderInitialMessages`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4444-L4459)).
  `/resume` inside a running TUI switches the runtime, whose rebind callback clears the chat and
  calls the same path
  ([rebind callback](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L696-L700),
  [`renderCurrentSessionState`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2397-L2407)).
  Messages older than the compaction are not drawn; the compaction summary is drawn in their place,
  and the status line reports how many times the session was compacted.
- **Per entry.** Each entry becomes messages through the same mapping as model context, but without
  context edits, so the UI shows original content
  ([`renderSessionEntries`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4328-L4349)).
  User messages are drawn and, at startup, added to editor history; system messages are skipped;
  summaries, shell commands, and displayable extension messages get their own components
  ([`addMessageToChat`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4074-L4216)).
- **Tools.** For each assistant message, a tool component is created per `toolCall` block. A later
  `toolResult` with the same `toolCallId` fills it. If the assistant message ended `aborted` or
  `error`, its tool components show an error instead. Calls still without a result become the
  pending tools
  ([`renderSessionItems`](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4218-L4320)).

The redraw renders final messages only. No streaming events are replayed, because none are stored.

## 8. Comparison with this repository

| Concern | Pi session file | This repository today |
| --- | --- | --- |
| Unit | One file per conversation, many prompts | One Agent Run per Coding Task, starting with an empty transcript ([`open-run.ts`](../../packages/agent-core/src/open-run.ts)) |
| Persisted record | Final messages plus state-change entries | Headless mode writes Run Events to `events.jsonl` with `schemaVersion: 1` on each line, omitting deltas and progress ([ADR 0005 §4](../adr/0005-terminalbench-evaluation-protocol.md), [`run-files.ts`](../../packages/coding-agent/src/run-files.ts)) |
| Message shape | `system`, `user`, `assistant`, `toolResult` messages, each with a timestamp | `Message = UserMessage \| AssistantMessage`; tool results are `tool_result` blocks inside user messages; no timestamps or IDs on messages ([`types.ts`](../../packages/ai/src/types.ts)) |
| Ordering | `id`/`parentId` tree plus file order | `sequence` in the event envelope is the sole ordering authority ([ADR 0002 §6](../adr/0002-agent-session-state-machine-and-event-protocol.md)) |
| Approval, Verification, limits | No entry types; Pi has no built-in permission system and does not ask before tool calls ([README](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/README.md#L88-L90), [security doc](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/security.md#L3)) | First-class events: `approval_*`, `verification_*`, `runtime_limit_reached`, `run_settled` with the Agent Result ([`events.ts`](../../packages/agent-core/src/events.ts)) |
| Model and prompt | `model_change`, `thinking_level_change`, persisted system messages | `run.json` records provider, model, and the assembled system prompt once per run ([ADR 0005 §4](../adr/0005-terminalbench-evaluation-protocol.md)) |
| Compaction | `compaction` and `branch_summary` entries | Deferred: the transcript is the only in-run memory ([ADR 0003 §4](../adr/0003-mvp-context-planning-verification-and-session-memory.md)) |
| Redraw | Final messages on the active branch, mapped to components in `interactive-mode.ts` | Run Events folded into the TUI model by `projectRunEvent` ([`projection.ts`](../../packages/coding-agent/src/projection.ts)); nothing is read back from disk |
| Versioning | One `version` in the header; load-time migration rewrites the file | No per-event version in memory; a version is needed once events are persisted ([ADR 0002 §7](../adr/0002-agent-session-state-machine-and-event-protocol.md)), and ADR 0005 put it on every line |

ADR 0002 §1 also says Run Events are observations, not an event-sourcing or replay contract.
Rebuilding a Session from persisted events would make them one, which is a change to that ADR
rather than a use of it.

## 9. Implications for CDA-141

Options and their consequences, grouped by the decisions CDA-141 has to make. No option is
recommended here.

### What a line records

- **Pi-style entries** (final messages plus state entries). Resume and redraw read the file
  directly, as in Pi. Approval decisions, Verification evidence, cancellation, limits, and Agent
  Results are lost unless new entry types are added for them; our `Message` would also need
  timestamps, since Pi's list time comes from message timestamps.
- **Run Events** in the ADR 0002 envelope, as `events.jsonl` already does. One writer and one
  schema serve both headless and interactive runs, and Approval and Verification history survives.
  Resume then needs a projection from events back to a model transcript, which does not exist
  today, and treats events as replayable, which ADR 0002 §1 rules out. Pi stores no deltas, and
  ADR 0005 already omits `assistant_content_delta` and progress from `events.jsonl`.
- **Both**: message entries for resume plus event entries for audit, in one file or two. Each
  half stays simple to read; the cost is two shapes to version and keep consistent.

### Session and Agent Run boundaries

Pi has no entry marking where one prompt's run begins or ends; `agent_end` is not stored, and a
user message is the only boundary. A Session holding many Agent Runs could add explicit run-start
and run-settled entries carrying the run ID and Agent Result, or leave runs implicit as Pi does.
Either way, Agent Core currently opens every Agent Run with an empty transcript, so resuming
also needs Agent Core to accept a prior transcript.

### Tree or linear

- **Carry Pi's tree** (`id`, `parentId`, leaf, `branch_summary`, `label`). Enables `/tree`-style
  branching later, at the cost of leaf tracking and branch-aware listing and redraw now.
- **Linear file.** Simplest to write and read. Pi's v1 to v2 migration shows the cost of adding the
  tree afterwards: every old file had to be rewritten with generated IDs.
- **Linear writes with `id` and `parentId` fields anyway.** Keeps a later tree a non-breaking
  addition while writing a chain today.

### Compaction, model changes, and other state entries

- `compaction` and `branch_summary` matter only once compaction or branching exists, and
  ADR 0003 §4 defers compaction. Dropping them now keeps redraw a plain replay; reserving the type
  name costs nothing.
- Model and thinking changes: Pi records them so a resume restores the model, and only if its
  provider still has credentials. If our model stays fixed per process by configuration, the model
  could be recorded once per Agent Run (as `run.json` does) instead of as change entries.
- Persisted system messages let Pi replay the exact prompt; recording the assembled system prompt
  per Agent Run gives the same audit value without patch semantics.
- `usage`, `custom`, `custom_message`, `context_edit` and `label` serve Pi features (cache warming,
  extensions, context edits, bookmarks) with no counterpart in our MVP.

### Versioning

Pi keeps one `version` in the header, migrates on load, and adds entry types within a version by
having readers ignore unknown types. ADR 0005 instead writes `schemaVersion` on every line. A
header version describes the whole file, so a release that changes a line's shape must migrate the
file before appending to it (Pi rewrites it on load). A per-line version lets one file hold lines
from different releases without a rewrite, at the cost of a field on every line.

### Credentials

Pi's approach is structural only: no key enters a message, and keys live in a separate `0600` file.
"Credentials removed" in our plan can mean that alone, or that plus scrubbing known credential
values from tool arguments and results before writing (Pi does neither), plus an explicit `0600`
mode on session files (Pi does not set one). Scrubbing changes stored tool output, which then
differs from what the model saw.

### Location and grouping

- **By exact cwd** (Pi). A worktree is its own list, and so is every subdirectory of a repository.
- **By repository top level** (`git rev-parse --show-toplevel`). Subdirectories share a list; each
  linked worktree is still its own list.
- **By shared git directory** (`--git-common-dir`). All worktrees of a repository share one list.
  To resume a Session in the worktree it came from, the header must record that worktree's path,
  as Pi's `cwd` does, and the missing-directory case Pi handles (continue, fork, or cancel) applies
  when the worktree has been removed.
- **Home directory versus inside the repository.** Pi stores under `~/.pi`, which keeps transcripts
  out of commits. A directory inside the repository would need an ignore rule to stay out of
  commits, and would be deleted together with the working tree it lives in.

The planned file name `<time>_<id>.jsonl` matches Pi exactly; Pi uses a UTC ISO timestamp with
`:` and `.` replaced and a UUIDv7, so files sort by name in creation order.

### Flags and lookup

Pi's choices that CDA-141 can copy or change: `--no-session` silently wins over the other flags
instead of erroring; `--continue` picks by file mtime and creates a new session if none exists;
`--session` accepts paths and ID prefixes and searches other projects with a fork prompt; and
`--resume` defaults to the current folder. Pi has no `sessions` subcommand; its listing lives in
the picker and `/session`. A non-interactive `coding-agent sessions` would need the same derived
fields as the picker.

### Resume list fields

Pi reads every file in full to derive name, time, and length, so the cost grows with session size
and count. Our plan's "name from the first prompt" equals Pi's fallback. For length, Pi's count of
every message entry is cheap but overstates the number of prompts; a count of Agent Runs or of user
prompts matches what the person typed. Cheaper listing would need the header (or a trailing summary
line) to carry these fields, which conflicts with append-only writes unless it is a separate index.

### Redraw

- **From final messages** (Pi). Rebuild tool components by pairing calls and results by ID; for our
  `Message` shape that means pairing `tool_call` blocks with `tool_result` blocks in the following
  user message. Approval and Verification history would not appear unless stored separately.
- **By folding stored events through the existing projection.** Coding Agent already turns each
  Run Event into the TUI model with the pure `projectRunEvent`, and keeps earlier Agent
  Runs in the transcript
  ([`projection.ts`](../../packages/coding-agent/src/projection.ts),
  [ADR 0004 §6](../adr/0004-package-apis-and-dependency-direction.md)). Replaying a stored log
  through it would redraw Approval and Verification as they were shown live. It relies on events
  being a replay contract, against ADR 0002 §1. Without deltas (`events.jsonl` omits them) the
  completed message still supplies the text, but streamed reasoning is lost, because the
  projection takes reasoning only from deltas.

### Write timing

Pi creates the file lazily at the first user or assistant message and appends synchronously per
entry, rolling back memory when a write fails. Our `events.jsonl` writer is a consumer the producer
never awaits, so a killed process can lose the tail (ADR 0005 §4). A Session file could follow
either model. Synchronous appends block on every write but lose at most the entry being written;
in both designs a message still streaming when the process dies is not on disk.

## Open points the sources do not settle

- Pi gives no rationale for grouping by exact cwd rather than by repository, and has no
  repository- or worktree-aware session behavior to compare with.
- Pi does not scrub credentials or set file modes on session files, so it offers no precedent for
  what "credentials removed" should cover beyond keeping keys out of messages.
- Pi's docs describe the session ID as "a UUID"; the code generates UUIDv7. This note follows the
  code.
- Pi does not lock session files. How it behaves when two processes resume the same session was not
  tested here.
