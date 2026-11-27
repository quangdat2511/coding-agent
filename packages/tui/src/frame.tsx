import { Box, Text, useCursor } from "ink";
import type { EditorView } from "./editor.ts";
import { ALLOW_KEY, DENY_KEY, type InputMode, type KeyPress } from "./input.ts";
import { ApprovalOverlay, type OverlayGeometry } from "./overlay.tsx";
import { type SessionViewRow, TASK_CONTINUATION, TASK_MARKER } from "./rows.ts";
import { SessionView } from "./session-view.tsx";
import { useTerminalInput, type WheelDirection } from "./terminal-input.ts";
import type { PendingApproval } from "./types.ts";

const HINT_HEIGHT = 1;
// The rows under the Session view while the Prompt has one row: the Prompt, then the key hint.
export const FOOTER_HEIGHT = 1 + HINT_HEIGHT;
// The share of the terminal's rows the Prompt grows to before it scrolls.
const PROMPT_SHARE = 0.3;

// How the frame shares out the rows of the terminal.
export interface FrameLayout {
  // The rows the Session view gets.
  readonly sessionViewHeight: number;
  // The rows the Prompt shows.
  readonly prompt: number;
  // Whether the key hint fits under the Prompt.
  readonly showHint: boolean;
  // The rows of the whole frame: the Session view, the Prompt and, when it shows, the key hint.
  readonly height: number;
}

// The most rows the Prompt shows on a terminal `screenRows` tall, one at least.
export function maxPromptRows(screenRows: number): number {
  return Math.max(1, Math.floor(screenRows * PROMPT_SHARE));
}

// How a terminal `screenRows` tall is shared out when the Prompt shows `promptRows` rows. The
// Prompt always shows; the key hint needs a row after it and the Session view one more, so a
// shorter terminal drops the hint, then the Session view, and the frame is never taller than the
// screen.
export function frameLayout(screenRows: number, promptRows = 1): FrameLayout {
  const prompt = Math.max(1, Math.min(promptRows, screenRows));
  const showHint = screenRows > prompt + HINT_HEIGHT;
  const footer = prompt + (showHint ? HINT_HEIGHT : 0);
  const sessionViewHeight = Math.max(0, screenRows - footer);
  return { sessionViewHeight, prompt, showHint, height: sessionViewHeight + footer };
}

// What each step's keys do, cancel keys first, so a narrow terminal cuts the hint after them.
export const KEY_HINTS = {
  prompt: "Esc/Ctrl+C cancel · Enter submit · Ctrl+J new line · PgUp/PgDn scroll",
  approval: `Esc/Ctrl+C cancel · ${ALLOW_KEY} allow · ${DENY_KEY} deny · PgUp/PgDn scroll`,
  // The overlay has no room to show what would be allowed.
  denyOnly: `Esc/Ctrl+C cancel · ${DENY_KEY} deny · PgUp/PgDn scroll`,
  reason: "Esc/Ctrl+C cancel · Enter deny · PgUp/PgDn scroll",
} as const;

// The overlay as it is drawn: the Approval, where its parts go, and the reason once one is typed.
export interface OverlayProps {
  readonly approval: PendingApproval;
  readonly geometry: OverlayGeometry;
  readonly reason: EditorView | undefined;
}

// The whole frame: the Session view rows in view with the Approval overlay over them, the Prompt
// and the key hint. mountTui decides everything on it and renders it again for each frame; this
// component draws it, places the terminal's cursor and hands keys, paste and wheel steps to mountTui.
export function Frame({
  rows,
  layout,
  columns,
  prompt,
  mode,
  overlay,
  cursor,
  interactive,
  onKey,
  onPaste,
  onWheel,
}: {
  rows: readonly SessionViewRow[];
  layout: FrameLayout;
  // The width of the terminal.
  columns: number;
  // The rows of the Prompt in view.
  prompt: EditorView;
  mode: InputMode;
  // Undefined while the Prompt has the keys.
  overlay: OverlayProps | undefined;
  // The cell, counted from the top of the frame, of the text that has the keys, where the next
  // character goes. Undefined while allow or deny is chosen, when no text has the keys.
  cursor: { readonly x: number; readonly y: number } | undefined;
  // Whether mountTui draws on a terminal.
  interactive: boolean;
  onKey(input: string, key: KeyPress): void;
  onPaste(text: string): void;
  onWheel(direction: WheelDirection): void;
}) {
  useTerminalInput({ interactive, onKey, onPaste, onWheel });

  // The terminal's own cursor marks where the next character goes. Unlike a cell drawn in inverse
  // video it shows when colors are off, and an input method draws the letter it is composing there.
  const { setCursorPosition } = useCursor();
  setCursorPosition(cursor === undefined ? undefined : inkCursorPosition(cursor));

  const hint =
    mode === "approval" && overlay !== undefined && overlay.geometry.summaryRows === 0
      ? KEY_HINTS.denyOnly
      : KEY_HINTS[mode];
  return (
    <Box flexDirection="column" height={layout.height}>
      <Box height={layout.sessionViewHeight}>
        <SessionView rows={rows} height={layout.sessionViewHeight} />
        {overlay === undefined ? null : (
          <ApprovalOverlay
            approval={overlay.approval}
            geometry={overlay.geometry}
            columns={columns}
            reason={overlay.reason}
          />
        )}
      </Box>
      {prompt.rows.map((text, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows are laid out again each frame
        <Text key={index} wrap="truncate-end">
          {(prompt.firstRow + index === 0 ? TASK_MARKER : TASK_CONTINUATION) + text}
        </Text>
      ))}
      {layout.showHint ? <Text wrap="truncate-end">{hint}</Text> : null}
    </Box>
  );
}

// The position to give Ink for the cell at column `x` of frame row `y`. Ink moves the cursor up
// from the row after its output (buildCursorSuffix in ink/build/cursor-helpers.js), but a frame
// that fills the screen, as this one always does, ends without a newline (ink/build/ink.js), so
// the cursor starts on the last row instead and Ink would land one row too high.
function inkCursorPosition(cell: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return { x: cell.x, y: cell.y + 1 };
}
