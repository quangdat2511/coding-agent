# Agent Core

The Agent Core context describes the controlled lifecycle that turns one requested code change
into actions and evidence.

## Language

**Coding Task**:
A natural-language objective to inspect or change one selected code repository.
_Avoid_: Prompt, chat, job

**Agent Session**:
The in-memory lifecycle that executes exactly one Coding Task.
_Avoid_: Conversation, persistent session

**Model Turn**:
One model request and streamed response together with the resolution of every Tool Call produced
by that response.
_Avoid_: Message, prompt, loop iteration

**Agent State**:
The authoritative current snapshot of an Agent Session, including its lifecycle, transcript,
active work, and outcome.
_Avoid_: Runtime state, UI state, event log

**Session Event**:
An ordered observation that a committed change occurred within an Agent Session.
_Avoid_: Provider event, UI event, replay command

**Candidate Completion**:
A model response with no Tool Calls that proposes the Coding Task is finished but has not yet
passed Verification.
_Avoid_: Final answer, successful result

**Agent Result**:
The single terminal outcome of an Agent Session, including its completion status and supporting
evidence or failure reason.
_Avoid_: Exit code, final message, summary

**Session Limits**:
The bounded runtime constraints (model turns, tool calls, active execution duration, and consecutive recoverable failures) enforced on an Agent Session to guarantee termination.
_Avoid_: Quotas, timeouts, guardrails

**Repository Root**:
The canonical directory of the selected code repository, to which every filesystem action of a tool is confined.
_Avoid_: cwd, workspace, project dir

**Path Jail**:
The rule that accepts a model-supplied path only when it stays inside the Repository Root and passes through no symbolic link.
_Avoid_: Sandbox, chroot

**Tool Call**:
A model request to invoke one controlled agent capability.
_Avoid_: Function call, command

**Approval**:
The recorded decision that allows or rejects a proposed mutating action before it executes, made by a human under the `ask` Approval Policy or by the policy itself under `auto-approve`.
_Avoid_: Confirmation, permission flag

**Approval Policy**:
The rule set determining whether a proposed mutating action requires human review or executes automatically.
_Avoid_: Permission mode, security level, bypass flag

**Schema Validation**:
Checking model-supplied tool arguments against a declared parameter schema before invocation. This is distinct from post-change Verification.
_Avoid_: Verification, testing

**Tool Result**:
The normalized outcome returned to the model and runtime after a Tool Call executes, is rejected, or fails.
_Avoid_: Command output, execution response

**Output Budget**:
The 40 KiB of UTF-8 that bounds a Tool Result's content, keeping the start and the end of longer output around a truncation marker.
_Avoid_: Output limit, truncation size, max output

**Tool Progress**:
The latest tail of a running Tool Call's output, delivered to observers at a bounded size and rate; each update replaces the previous one.
_Avoid_: Progress message, partial result, streaming output

**Verification**:
Evidence gathered after a change to determine whether the Coding Task's result is valid.
_Avoid_: Testing, validation

**Verification Policy**:
The injected rule set that evaluates a Candidate Completion and decides whether the Agent Session succeeds, continues with feedback, or fails.
_Avoid_: Test runner, evaluation script, completion validator

**Verification Runner**:
The execution adapter responsible for launching and supervising verification commands in the workspace environment and returning a discriminated runner result.
_Avoid_: Test runner, shell executor, subshell, CI runner

**Verification Evidence**:
Structured observations (such as command execution records, exit codes, and output payloads) gathered during Verification to substantiate task completion.
_Avoid_: Test logs, proof, verification data

**Project Instructions**:
Repository-level guidance documents (such as `AGENTS.md`) loaded into the initial session context to guide model behavior.
_Avoid_: System prompt, context file, rules

**Scratchpad**:
A temporary in-repository workspace or file (such as `.scratch/`) used by the agent for planning and intermediate notes.
_Avoid_: Memory, workspace cache, draft directory

**Cancellation**:
The commanded termination of an Agent Session from any nonterminal state, which halts further execution, signals active adapters, and quiesces before settling.
_Avoid_: Abort, stop, kill, interruption

**Quiescence**:
The state where all in-flight asynchronous effects (model streaming, tool execution, or verification) have completely finished, aborted, or timed out before terminal settlement.
_Avoid_: Inactivity, idle, drain

**Cancellation Grace Period**:
The time window an Agent Session allows active effects to quiesce after cancellation before forcefully settling as failed with `CANCELLATION_TIMEOUT`.
_Avoid_: Cancellation timeout, abort window, grace delay

**Skipped Tool Call**:
An unstarted queued Tool Call that is terminated with reason `CANCELLED` (or failure code) without executing or producing a Tool Result because the session is terminating.
_Avoid_: Cancelled call, dropped call, abandoned call
