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

**Verification**:
Evidence gathered after a change to determine whether the Coding Task's result is valid.
_Avoid_: Testing, validation
