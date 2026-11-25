# Coding Agent

The Coding Agent context describes the user-facing application formed by composing the other
project contexts.

## Language

**Coding Agent**:
The application that accepts a Coding Task and coordinates model interaction, controlled tools,
Agent Runs, and the Full-screen TUI.
_Avoid_: Chatbot, assistant, model

### Sessions

**Session**:
The conversation the person sees: many Agent Runs, one per Coding Task, over one Transcript that
is saved and can be reopened.
_Avoid_: Agent Run, chat, thread

**Session name**:
The short label a Session is listed under: the model's summary of its first Coding Task, or that
task's first line until a summary exists.
_Avoid_: Title

**Session file**:
The append-only record of one Session, kept outside the repository, from which the Session is
listed, resumed and redrawn. It holds the Session's Run Events and a few records of Coding Agent's
own.
_Avoid_: Transcript file, history, session log (`events.jsonl` is the headless run's file)

**Resume**:
Opening a saved Session so that the person's next Coding Task runs as a new Agent Run over its
Transcript.
_Avoid_: Restore, reload, replay

**Session lock**:
The claim one Coding Agent process holds on a Session while it has the Session open. Only the
holder writes the Session file; every other process sees the Session as open elsewhere and cannot
open it.
_Avoid_: Lockfile, mutex, in use, busy

**Worktree**:
A separate checkout of the repository that Coding Agent creates on a branch of its own, so Sessions
can change files without touching the person's checkout and several Coding Agents can work on one
repository at once. A checkout the person made with `git worktree add` is not one.
_Avoid_: Sandbox, clone, copy, workspace

### Prompt Queue

**Prompt Queue**:
The Steers and Follow-ups of a Session that wait to be taken or started, each with an id it keeps
when it changes kind.
_Avoid_: Message queue, pending input, queued prompts

**Follow-up**:
A Coding Task the person queues while another runs. It opens its own Agent Run after a run
succeeds, or when the person sends it now while no run is active.
_Avoid_: Queued message, next prompt

### Session Controller

**Session Controller**:
The part of Coding Agent that owns the current Session, its Prompt Queue and its active Agent Run,
and carries out Actions for any client, checking every condition itself.
_Avoid_: Core, session manager, host

**Action**:
A named request a client makes to the Session Controller, with JSON arguments, answered by a reply
that either carries the result or refuses with a reason.
_Avoid_: Command (an Agent Run's commands), event

**Client**:
What drives the Session Controller for a person; in stage 1, only the Full-screen TUI.
_Avoid_: Frontend, host

### Evaluation

**TerminalBench Evaluation**:
A reproducible run that records this Coding Agent's results on TerminalBench without using Pi's
score as a pass or fail threshold.
_Avoid_: Pi comparison, benchmark competition

**Evaluation Profile**:
A named, source-controlled set of Run Limits selected for a run; it changes no prompt,
tool, or model setting.
_Avoid_: Benchmark mode, eval config, limit flags

**Isolation Record**:
The dated list, kept with the repository, of the passing runs of the credential isolation test
for one artifact. Each run names a backend and an agent user. It is distinct from the artifact
manifest, which the build writes before any test runs, and from the job manifest, which the record
tooling writes after a job.
_Avoid_: Isolation manifest, isolation report
