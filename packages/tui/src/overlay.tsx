import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { EditorView } from "./editor.ts";
import { ALLOW_KEY, DENY_KEY } from "./input.ts";
import { wrap } from "./rows.ts";
import type { PendingApproval } from "./types.ts";

// The border's rows and columns, and the space inside it on either side of the text.
const BORDER = 1;
const MARGIN = " ";
const CHOICES = `${ALLOW_KEY} allow · ${DENY_KEY} deny`;
const REASON_LABEL = "Reason: ";

// Where each part of the Approval overlay goes over a Session view `height` rows tall on a terminal
// `columns` wide. Drawing, the width the reason is typed in and the cursor all read it from here,
// so they agree on whether the overlay has a border.
export interface OverlayGeometry {
  // The Session view rows the overlay is drawn over: none, when the terminal has no row for it.
  readonly height: number;
  readonly bordered: boolean;
  // The columns inside the border, and those inside the margins.
  readonly inner: number;
  readonly textColumns: number;
  // The rows for the tool and its mutation summary. With none, nothing shows what a decision
  // would allow, so only deny is offered.
  readonly summaryRows: number;
  // The width the denial reason is typed in, and its first cell: the column and the row from the
  // top of the frame.
  readonly reasonColumns: number;
  readonly reasonOrigin: { readonly x: number; readonly y: number };
}

// The summary takes at most half the Session view's rows, so the choices always show and some of
// the Session view stays in view. The border takes two rows, so it is drawn only when a summary row
// and the choices fit inside it.
export function overlayGeometry(columns: number, height: number): OverlayGeometry {
  const bordered = height >= 2 * BORDER + 2;
  const border = bordered ? BORDER : 0;
  const inner = Math.max(1, columns - 2 * border);
  const textColumns = Math.max(1, inner - 2 * MARGIN.length);
  return {
    height: Math.max(0, height),
    bordered,
    inner,
    textColumns,
    summaryRows: Math.max(0, Math.min(height - 1 - 2 * border, Math.floor(height / 2) || 1)),
    reasonColumns: Math.max(1, textColumns - REASON_LABEL.length),
    reasonOrigin: { x: border + MARGIN.length + REASON_LABEL.length, y: height - 1 - border },
  };
}

// Allowing needs the person to have seen what they allow: the tool and its summary.
export function canAllow(geometry: OverlayGeometry): boolean {
  return geometry.summaryRows > 0;
}

// The Approval overlay, drawn over the bottom of the Session view so that the rows above it and the
// scroll position underneath stay as they were. It shows the tool and its mutation summary, then
// either the choices or, after n, the reason being typed.
//
// Ink writes only the cells a <Text> covers and leaves the rest of the box showing the Session view
// through it, so every row inside the border is padded to the full width, the margin on each side
// included. A Session view with no rows gets no overlay, though its keys still work.
export function ApprovalOverlay({
  approval,
  geometry,
  columns,
  reason,
}: {
  approval: PendingApproval;
  geometry: OverlayGeometry;
  columns: number;
  // The reason being typed, once the person has pressed n.
  reason: EditorView | undefined;
}) {
  const { height, bordered, inner, textColumns, summaryRows } = geometry;
  if (height <= 0) {
    return null;
  }
  const wrapped = wrap(`${approval.toolName} ${approval.summary}`, textColumns);
  const summary = wrapped.slice(0, summaryRows);
  if (wrapped.length > summary.length && summary.length > 0) {
    // Ink cuts the line at the row's width and ends it with an ellipsis. Wrapping leaves the space
    // the line was broken at, which would stand before it.
    summary[summary.length - 1] = `${summary.at(-1)?.trimEnd()}…`;
  }
  const choices = canAllow(geometry)
    ? CHOICES
    : `${approval.toolName} · ${DENY_KEY} deny · enlarge to allow`;
  const lastRow =
    reason === undefined
      ? `${MARGIN}${choices}`
      : `${MARGIN}${REASON_LABEL}${fill(reason.rows[0] ?? "", geometry.reasonColumns)}`;
  return (
    <Box
      position="absolute"
      bottom={0}
      left={0}
      width={columns}
      flexDirection="column"
      borderStyle={bordered ? "round" : undefined}
    >
      {[...summary.map((line) => `${MARGIN}${line}`), lastRow].map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows are laid out again each frame
        <Text key={index} wrap="truncate-end">
          {fill(line, inner)}
        </Text>
      ))}
    </Box>
  );
}

function fill(text: string, columns: number): string {
  return text + " ".repeat(Math.max(0, columns - stringWidth(text)));
}
