# Terminal UI

The Terminal UI context describes how a person observes and controls an Agent Run inside a
terminal.

## Language

**Full-screen TUI**:
A terminal interface that owns and redraws the terminal screen while presenting the Agent Run
and accepting user decisions.
_Avoid_: CLI output, command prompt, terminal framework

**Prompt**:
The input under the transcript where the person types a Coding Task and submits it with Enter. It
holds several lines, started with Shift+Enter, Alt+Enter or Ctrl+J, and grows with its text up to a
share of the screen. The Prompt is where the text is typed; the submitted text is the Coding Task.
_Avoid_: Input box, command line, system prompt

**Approval overlay**:
The box drawn over the bottom of the transcript while an Approval is pending. It shows the tool
and its mutation summary; the person allows with `y`, or denies with `n` and then types an optional
reason and presses Enter. `y` and `n` count only after the keyboard has been quiet for a moment,
and `y` only while the summary is in view. The transcript underneath keeps its content and scroll
position.
_Avoid_: Approval dialog, popup, modal, confirmation prompt

**Quit**:
The person's own ending of the Full-screen TUI, made while no Agent Run is active by pressing the
cancel key twice in quick succession. A single press only asks the person to confirm, and while an
Agent Run is active the same key starts Cancellation instead, so a Quit never discards a running
Coding Task. A signal that ends the run from outside is not a Quit.
_Avoid_: Exit, close, abort, cancel
