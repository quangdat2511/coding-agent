import { Box, Text, useCursor, useInput, usePaste, useStdin } from "ink";
import { useRef, useState } from "react";
import { type Editor, EMPTY_EDITOR, edit } from "./editor.ts";
import { EditorRow, editorCursorColumn } from "./editor-row.tsx";
import { type InputMode, type KeyAction, routeKey, routePaste } from "./input.ts";
import { ApprovalOverlay, reasonColumns, reasonOrigin } from "./overlay.tsx";
import { TASK_MARKER, type TranscriptRow } from "./rows.ts";
import { Transcript } from "./transcript.tsx";
import type { TuiHandlers, TuiModel } from "./types.ts";

const PROMPT_HEIGHT = 1;
const HINT_HEIGHT = 1;
// The rows under the transcript: the Prompt, then the key hint.
export const FOOTER_HEIGHT = PROMPT_HEIGHT + HINT_HEIGHT;

// How the frame shares out the rows of the terminal.
export interface FrameLayout {
  // The rows the transcript gets.
  readonly transcript: number;
  // Whether the key hint fits under the Prompt.
  readonly showHint: boolean;
  // The rows of the whole frame: the transcript, the Prompt and, when it shows, the key hint.
  readonly height: number;
}

// How a terminal `screenRows` tall is shared out. The Prompt always shows; the key hint needs a
// third row and the transcript a second, so a shorter terminal drops the hint, then the
// transcript, and the frame is never taller than the screen.
export function frameLayout(screenRows: number): FrameLayout {
  const showHint = screenRows > FOOTER_HEIGHT;
  const footer = showHint ? FOOTER_HEIGHT : PROMPT_HEIGHT;
  const transcript = Math.max(0, screenRows - footer);
  return { transcript, showHint, height: transcript + footer };
}

// What each mode's keys do, cancel keys first, so a narrow terminal cuts the hint after them.
export const KEY_HINTS: Record<InputMode, string> = {
  prompt: "Esc/Ctrl+C cancel · Enter submit · PgUp/PgDn scroll",
  approval: "Esc/Ctrl+C cancel · y allow · n deny · PgUp/PgDn scroll",
  reason: "Esc/Ctrl+C cancel · Enter deny · PgUp/PgDn scroll",
};

// Everything the keys change apart from the scroll position, which stays with mountTui.
interface InputState {
  readonly prompt: Editor;
  // The Approval the person last decided. The overlay closes at once, before the host takes the
  // Approval out of the model, so a second key press cannot decide it again.
  readonly decided?: string;
  // The reason being typed after n, with the Approval it denies. A new Approval has a new
  // identifier, so it opens with no reason and asks for allow or deny again.
  readonly reason?: { readonly approvalId: string; readonly editor: Editor };
}

type Approval = NonNullable<TuiModel["pendingApproval"]>;

function inputMode(state: InputState, approval: Approval | undefined): InputMode {
  if (approval === undefined || approval.approvalId === state.decided) {
    return "prompt";
  }
  return state.reason?.approvalId === approval.approvalId ? "reason" : "approval";
}

// The whole frame: the transcript rows in view with the Approval overlay over them, the Prompt and
// the key hint. Every key and paste goes through the input policy, and this component carries out
// what it decides. mountTui renders it again for each frame, so the text typed, kept here, survives
// transcript updates. The scroll position stays with mountTui, which lays out the rows, so
// scrolling goes back to it as onScroll.
export function Frame({
  rows,
  layout,
  columns,
  approval,
  interactive,
  handlers,
  onScroll,
}: {
  rows: readonly TranscriptRow[];
  layout: FrameLayout;
  // The width of the terminal.
  columns: number;
  approval: Approval | undefined;
  // Whether mountTui draws on a terminal.
  interactive: boolean;
  handlers: TuiHandlers;
  // -1 for a page toward older entries, 1 for a page toward the newest.
  onScroll(direction: -1 | 1): void;
}) {
  const [state, setState] = useState<InputState>({ prompt: EMPTY_EDITOR });
  // The state as the last action left it. Ink can deliver several key presses before React renders
  // the state they set, as with an input method's Backspace and replacement letter in one read, so
  // each action works on this rather than on `state`, and the mode is read for each key press.
  const latest = useRef(state);
  const mode = inputMode(state, approval);
  const promptColumns = Math.max(1, columns - TASK_MARKER.length);

  function perform(actions: readonly KeyAction[]) {
    let next = latest.current;
    for (const action of actions) {
      const current = inputMode(next, approval);
      switch (action.kind) {
        case "insert":
        case "backspace":
        case "delete":
        case "move":
          if (current === "reason" && next.reason !== undefined) {
            const editor = edit(next.reason.editor, action, reasonColumns(columns));
            next = { ...next, reason: { ...next.reason, editor } };
          } else if (current === "prompt") {
            next = { ...next, prompt: edit(next.prompt, action, promptColumns) };
          }
          break;
        case "submit":
          next = current === "reason" ? denyWithReason(next) : submitTask(next);
          break;
        case "scroll":
          onScroll(action.direction);
          break;
        // Whether a task is running is the host's to know: it ignores a cancel with none. The
        // Prompt keeps its text, which may be the next task.
        case "cancel":
          handlers.onCancel();
          break;
        case "allow":
          if (current === "approval" && approval !== undefined) {
            handlers.onApproval(approval.approvalId, "allow");
            next = { ...next, decided: approval.approvalId };
          }
          break;
        case "deny":
          if (current === "approval" && approval !== undefined) {
            next = { ...next, reason: { approvalId: approval.approvalId, editor: EMPTY_EDITOR } };
          }
          break;
        default: {
          const unhandled: never = action;
          throw new Error(`Unhandled key action: ${JSON.stringify(unhandled)}`);
        }
      }
    }
    latest.current = next;
    setState(next);
  }

  // Spaces around the task, such as the one a pasted line break leaves, are not part of it, and a
  // Prompt of only spaces has no Coding Task to start; Enter clears the Prompt either way. Input
  // methods may send a letter composed or as a base and combining marks; NFC sends the same text
  // in one form.
  function submitTask(next: InputState): InputState {
    const task = next.prompt.text.trim();
    if (task !== "") {
      handlers.onSubmit(task.normalize("NFC"));
    }
    return { ...next, prompt: EMPTY_EDITOR };
  }

  // A reason of only spaces is no reason, so the denial goes without one.
  function denyWithReason(next: InputState): InputState {
    if (next.reason === undefined) {
      return next;
    }
    const { approvalId, editor } = next.reason;
    const reason = editor.text.trim().normalize("NFC");
    if (reason === "") {
      handlers.onApproval(approvalId, "deny");
    } else {
      handlers.onApproval(approvalId, "deny", reason);
    }
    return { ...next, decided: approvalId, reason: undefined };
  }

  // Ink reads keys only from a stdin it can switch to raw mode, and throws for any other. Without
  // one, as when input is piped, the TUI still draws and takes no input. When mountTui draws
  // nothing, as when output is piped, raw mode would leave the person typing at a blank screen
  // where Ctrl+C no longer stops the process, so it takes no input then either. Ink's flag is
  // stdin's isTTY, undefined on a plain stream, and the hooks treat only false as inactive.
  const { isRawModeSupported } = useStdin();
  const takesInput = interactive && isRawModeSupported === true;
  const modeNow = () => inputMode(latest.current, approval);
  useInput((input, key) => perform(routeKey(modeNow(), input, key)), { isActive: takesInput });
  usePaste((pasted) => perform(routePaste(modeNow(), pasted)), { isActive: takesInput });

  // The terminal's own cursor marks where the next character goes, in the text that has the keys.
  // Unlike a cell drawn in inverse video it shows when colors are off, and an input method draws
  // the letter it is composing there. While allow or deny is being chosen no text has the keys,
  // so the cursor is hidden.
  const { setCursorPosition } = useCursor();
  const origin = mode === "reason" ? reasonOrigin(layout.transcript) : undefined;
  if (mode === "prompt") {
    setCursorPosition(
      onScreen(
        TASK_MARKER.length + editorCursorColumn(state.prompt, promptColumns),
        layout.transcript,
      ),
    );
  } else if (origin !== undefined && state.reason !== undefined) {
    const column = editorCursorColumn(state.reason.editor, reasonColumns(columns));
    setCursorPosition(onScreen(origin.x + column, origin.y));
  } else {
    setCursorPosition(undefined);
  }

  return (
    <Box flexDirection="column" height={layout.height}>
      <Box height={layout.transcript}>
        <Transcript rows={rows} height={layout.transcript} />
        {mode === "prompt" || approval === undefined ? null : (
          <ApprovalOverlay
            approval={approval}
            columns={columns}
            height={layout.transcript}
            reason={mode === "reason" ? state.reason?.editor : undefined}
          />
        )}
      </Box>
      {/* The marker keeps its width, which Ink would otherwise shrink to make room for the text. */}
      <Box>
        <Box flexShrink={0}>
          <Text>{TASK_MARKER}</Text>
        </Box>
        <EditorRow editor={state.prompt} columns={promptColumns} />
      </Box>
      {layout.showHint ? <Text wrap="truncate-end">{KEY_HINTS[mode]}</Text> : null}
    </Box>
  );
}

// The position to give Ink for the cell at column `x` of frame row `y`. Ink moves the cursor up
// from the row after its output (buildCursorSuffix in ink/build/cursor-helpers.js), but a frame
// that fills the screen, as this one always does, ends without a newline (ink/build/ink.js), so
// the cursor starts on the last row instead and Ink would land one row too high.
function onScreen(x: number, y: number): { x: number; y: number } {
  return { x, y: y + 1 };
}
