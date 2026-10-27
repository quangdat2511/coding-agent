import type { TranscriptRow } from "./rows.ts";

// Where the viewport sits over the transcript rows. "following" keeps the last row in view as rows
// are added. "anchored" names the top row in view by its entry and offset rather than by its
// index, so the view stays on the same text when rows above it change or the terminal is resized.
export type ScrollPosition =
  | { readonly kind: "following" }
  | { readonly kind: "anchored"; readonly entryId: string; readonly offset: number };

export const FOLLOWING: ScrollPosition = { kind: "following" };

// The index of the first row in view.
export function topRow(
  rows: readonly TranscriptRow[],
  height: number,
  position: ScrollPosition,
): number {
  const lastTop = Math.max(0, rows.length - height);
  if (position.kind === "following") {
    return lastTop;
  }
  const first = rows.findIndex((row) => row.entryId === position.entryId);
  // The anchored entry has left the transcript, so there is no text to stay on.
  if (first === -1) {
    return lastTop;
  }
  // The entry may now have fewer rows, for example after the terminal got wider.
  const last = rows.findLastIndex((row) => row.entryId === position.entryId);
  return Math.min(first + position.offset, last, lastTop);
}

// The position that puts row `top` first in view. A view that reaches the last row follows it.
export function positionAt(
  rows: readonly TranscriptRow[],
  height: number,
  top: number,
): ScrollPosition {
  const row = rows[Math.max(0, top)];
  if (row === undefined || top >= rows.length - height) {
    return FOLLOWING;
  }
  return { kind: "anchored", entryId: row.entryId, offset: row.offset };
}

// The rows one Page Up or Page Down moves a viewport `height` rows tall: one row of the previous
// view stays in sight, so the reader does not lose their place, and a page is at least one row.
export function pageRows(height: number): number {
  return Math.max(1, height - 1);
}
