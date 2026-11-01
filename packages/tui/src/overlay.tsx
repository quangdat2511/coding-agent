import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { Editor } from "./editor.ts";
import { EditorRow } from "./editor-row.tsx";
import { wrap } from "./rows.ts";
import type { TuiModel } from "./types.ts";

type Approval = NonNullable<TuiModel["pendingApproval"]>;

// The left and right border of the box, and the space inside each of them.
const BORDER_WIDTH = 2;
const MARGIN = " ";
const CHOICES = "y allow · n deny";
const REASON_LABEL = "Reason: ";

// The width the denial reason is typed in on a terminal `columns` wide.
export function reasonColumns(columns: number): number {
  return Math.max(1, columns - BORDER_WIDTH - 2 * MARGIN.length - REASON_LABEL.length);
}

// Where the denial reason starts in an overlay over a transcript `height` rows tall: its row from
// the top of the frame and its column. Undefined when the transcript has no rows and the overlay
// is not drawn.
export function reasonOrigin(height: number): { x: number; y: number } | undefined {
  if (height <= 0) {
    return undefined;
  }
  const border = height >= 3 ? 1 : 0;
  return { x: border + MARGIN.length + REASON_LABEL.length, y: height - 1 - border };
}

// The Approval overlay, drawn over the bottom of the transcript so that the rows above it and the
// scroll position underneath stay as they were. It shows the tool and its mutation summary, then
// either the choices or, after n, the reason being typed.
//
// Ink writes only the cells a <Text> covers and leaves the rest of the box showing the transcript
// through it, so every row inside the border is padded to the full width, the margin on each side
// included. The summary takes at most half the transcript's rows, cut with an ellipsis, so the
// choices always show and some of the transcript stays in view. A transcript too short for the
// border gets the last row alone, and one with no rows gets no overlay, though its keys still work.
export function ApprovalOverlay({
  approval,
  columns,
  height,
  reason,
}: {
  approval: Approval;
  columns: number;
  // The rows of the transcript the overlay is drawn over.
  height: number;
  // The reason being typed, once the person has pressed n.
  reason: Editor | undefined;
}) {
  if (height <= 0) {
    return null;
  }
  const bordered = height >= 3;
  const inner = Math.max(1, bordered ? columns - BORDER_WIDTH : columns);
  const textColumns = Math.max(1, inner - 2 * MARGIN.length);
  const summaryRows = bordered ? Math.min(height - 3, Math.max(1, Math.floor(height / 2))) : 0;
  const wrapped = wrap(`${approval.toolName} ${approval.summary}`, textColumns);
  const summary = wrapped.slice(0, summaryRows);
  if (wrapped.length > summary.length && summary.length > 0) {
    // Ink cuts the line at the row's width and ends it with an ellipsis.
    summary[summary.length - 1] = `${summary.at(-1)}…`;
  }
  const lastRow =
    reason === undefined ? (
      <Text wrap="truncate-end">{fill(`${MARGIN}${CHOICES}`, inner)}</Text>
    ) : (
      <Box>
        <Box flexShrink={0}>
          <Text>{`${MARGIN}${REASON_LABEL}`}</Text>
        </Box>
        <EditorRow editor={reason} columns={reasonColumns(columns)} fill />
        <Text>{MARGIN}</Text>
      </Box>
    );
  return (
    <Box
      position="absolute"
      bottom={0}
      left={0}
      width={columns}
      flexDirection="column"
      borderStyle={bordered ? "round" : undefined}
    >
      {summary.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines are laid out again each frame
        <Text key={index} wrap="truncate-end">
          {fill(`${MARGIN}${line}`, inner)}
        </Text>
      ))}
      {lastRow}
    </Box>
  );
}

function fill(text: string, columns: number): string {
  return text + " ".repeat(Math.max(0, columns - stringWidth(text)));
}
