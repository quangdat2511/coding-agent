# Terminal UI

The Terminal UI context describes how a person observes and controls an Agent Session inside a
terminal.

## Language

**Full-screen TUI**:
A terminal interface that owns and redraws the terminal screen while presenting the Agent Session
and accepting user decisions.
_Avoid_: CLI output, command prompt, terminal framework

**Prompt**:
The one-row input under the transcript where the person types a Coding Task and submits it. The
Prompt is where the text is typed; the submitted text is the Coding Task.
_Avoid_: Input box, command line, system prompt
