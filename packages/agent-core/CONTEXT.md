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

**Tool Call**:
A model request to invoke one controlled agent capability.
_Avoid_: Function call, command

**Approval**:
An explicit human decision that allows or rejects a proposed action before it executes.
_Avoid_: Confirmation, permission flag

**Approval Policy**:
The rule set determining whether a proposed mutating action requires human review or executes automatically.
_Avoid_: Permission mode, security level, bypass flag

**Tool Result**:
The normalized outcome returned to the model and runtime after a Tool Call executes, is rejected, or fails.
_Avoid_: Command output, execution response

**Verification**:
Evidence gathered after a change to determine whether the Coding Task's result is valid.
_Avoid_: Testing, validation
