# Terminal UI

The Terminal UI context describes how a person observes and controls a Session and its Agent Runs
inside a terminal.

## Language

**Full-screen TUI**:
A terminal interface that owns and redraws the terminal screen while presenting the Session and
accepting user decisions.
_Avoid_: CLI output, command prompt, terminal framework

**Session view**:
The area above the Prompt where the Full-screen TUI presents the Session: its Coding Tasks and
Steers, the model's replies, Tool Calls, Verification, each Agent Run's outcome, and notices.
_Avoid_: Transcript, chat log, scrollback

**Prompt**:
The input under the Session view. With no run active, Enter or the Follow-up key runs its text as a
Coding Task; during a run, Enter sends it as a Steer and the Follow-up key queues it as a Follow-up.
Lines start with Shift+Enter or Ctrl+J.
_Avoid_: Input box, command line, system prompt

**Queue strip**:
The rows above the Prompt showing each waiting Steer and Follow-up with its badge, and why
Follow-ups wait.
_Avoid_: Queue bar, pending list

**Queue selection mode**:
The mode, entered with Shift+Up, in which the person selects an item in the Queue strip to send
now, edit or delete.
_Avoid_: Queue mode, queue editor

**Session picker**:
The full-height list of the Repository Root's Sessions, opened with Ctrl+R, from which the person
resumes one.
_Avoid_: Resume list, session browser

**Approval overlay**:
The box drawn over the bottom of the Session view while an Approval is pending. It shows the tool
and its mutation summary; the person allows with `y`, or denies with `n` and then types an optional
reason and presses Enter. `y` and `n` count only after the keyboard has been quiet for a moment,
and `y` only while the summary is in view. The Session view underneath keeps its content and scroll
position.
_Avoid_: Approval dialog, popup, modal, confirmation prompt

**Quit**:
The person's own ending of the Full-screen TUI, made while no run is active by pressing the cancel
key twice: Esc or Ctrl+C at the Prompt, Ctrl+C in a mode. The first press asks for confirmation and
gives the number of waiting Follow-ups it discards. A signal is not a Quit.
_Avoid_: Exit, close, abort, cancel
