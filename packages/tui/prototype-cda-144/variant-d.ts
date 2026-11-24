// PROTOTYPE (CDA-144), throwaway. Variant D "Framed", the one chosen. A frame around the whole
// screen: the top border names the Session and repository with the run state on the right; the
// transcript, then A's strip with STEER, NEXT and WAIT badges between two separators, then the
// Prompt; the bottom border holds the key hints or a notice, and the queue counts.
import { editorView } from "../src/editor.ts";
import { transcriptRows, wrap } from "../src/rows.ts";
import { topRow } from "../src/viewport.ts";
import { type FakeCodingAgent, type QueueKind, REPO, type SessionRow } from "./host.ts";
import type { Platform, Row, Screen, Seg, Ui } from "./views.ts";
import { fit, sessionStatus, width } from "./views.ts";

export const MAX_ROWS = 6;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// The badge and the space after it.
export const BADGE_WIDTH = 6;
const MARKER = "› ";

type Badge = "STEER" | "NEXT" | "WAIT";

const BADGE_COLORS: Record<Badge, string> = { STEER: "magenta", NEXT: "cyan", WAIT: "yellow" };

function badgeOf(kind: QueueKind, waiting: boolean): Badge {
  if (kind === "steer") {
    return "STEER";
  }
  return waiting ? "WAIT" : "NEXT";
}

function badgeSegs(badge: Badge): Seg[] {
  return [{ text: badge.padEnd(5), bg: BADGE_COLORS[badge], color: "black" }, { text: " " }];
}

function symbolsOn(ui: Ui): boolean {
  return ui.symbols && ui.platform === "unix";
}

// The mockup's macOS symbols, or words on Windows and Linux.
export function keyLabel(text: string, symbols: boolean): string {
  if (!symbols) {
    return text;
  }
  return text
    .replace(/Shift\+Enter/g, "⇧⏎")
    .replace(/Alt\+Enter/g, "⌥⏎")
    .replace(/Shift\+Up/g, "⇧↑")
    .replace(/Alt\+Up/g, "⌥↑")
    .replace(/Ctrl\+([A-Z])/g, "⌃$1")
    .replace(/Up\/Down/g, "↑↓")
    .replace(/Enter/g, "⏎")
    .replace(/Esc/g, "esc");
}

function followUpKey(platform: Platform) {
  return platform === "unix" ? "Alt+Enter" : "Ctrl+Q";
}

export function hintD(ui: Ui, host: FakeCodingAgent): string {
  const queued = " · Shift+Up queue";
  let text: string;
  switch (ui.mode) {
    case "picker":
      text = "Enter open · Up/Down move · Esc close";
      break;
    case "edit":
      text = "Enter save · Shift+Enter new line · Esc keep old text";
      break;
    case "queue":
      text = "Enter send now · e edit · d delete · Up/Down move · Esc back · Ctrl+C cancel run";
      break;
    default:
      text =
        host.run !== undefined
          ? `Enter steer · ${followUpKey(ui.platform)} follow-up${queued} · Esc cancel · Shift+Enter new line`
          : `Enter run${queued} · Ctrl+R resume · Ctrl+N new · Esc Esc quit`;
  }
  return keyLabel(text, symbolsOn(ui));
}

function runState(host: FakeCodingAgent): Seg {
  if (host.run !== undefined) {
    const frame = SPINNER[Math.floor(Date.now() / 120) % SPINNER.length] ?? "⠋";
    return {
      text: ` ${frame} running · turn ${Math.max(1, host.run.turn)}/${host.run.turns} `,
      color: "blue",
    };
  }
  if (host.waitingReason() !== undefined) {
    return { text: " ! waiting ", color: "yellow" };
  }
  return { text: " ● idle ", color: "green" };
}

function segsWidth(segs: readonly Seg[]): number {
  return segs.reduce((sum, seg) => sum + width(seg.text), 0);
}

// A border row: corners, text at the left, dashes, text at the right.
function border(corner: [string, string], left: Seg[], right: Seg[], columns: number): Row {
  let leftSegs = left;
  let room = columns - 4 - segsWidth(left) - segsWidth(right);
  if (room < 1) {
    const cut = Math.max(0, segsWidth(left) + room - 1);
    leftSegs = [{ ...left[0], text: fit(left.map((seg) => seg.text).join(""), cut) }];
    room = 1;
  }
  return [
    { text: `${corner[0]}─`, dim: true },
    ...leftSegs,
    { text: "─".repeat(room), dim: true },
    ...right,
    { text: `─${corner[1]}`, dim: true },
  ];
}

// A row inside the frame: the side borders and a space of margin on each side.
function framed(segs: Seg[], inner: number): Row {
  const used = segsWidth(segs);
  const padding: Seg[] = used < inner ? [{ text: " ".repeat(inner - used) }] : [];
  return [{ text: "│ ", dim: true }, ...segs, ...padding, { text: " │", dim: true }];
}

function separator(columns: number): Row {
  return [{ text: `├${"─".repeat(Math.max(0, columns - 2))}┤`, dim: true }];
}

function stripD(
  ui: Ui,
  host: FakeCodingAgent,
  inner: number,
): { rows: Seg[][]; cursor?: { x: number; y: number } } {
  const items = host.items();
  const reason = host.waitingReason();
  const rows: Seg[][] = [];
  let cursor: { x: number; y: number } | undefined;
  const textColumns = Math.max(1, inner - BADGE_WIDTH);
  if (reason !== undefined && ui.mode === "prompt") {
    const how = keyLabel(
      "Enter runs your own task first; Shift+Up then Enter sends one now.",
      symbolsOn(ui),
    );
    rows.push([{ text: fit(`Follow-ups wait: ${reason}. ${how}`, inner), color: "yellow" }]);
  }
  const selectedIndex = Math.max(
    0,
    items.findIndex((entry) => entry.item.id === ui.selected),
  );
  let start =
    items.length <= MAX_ROWS
      ? 0
      : Math.min(Math.max(0, selectedIndex - 2), items.length - MAX_ROWS);
  if (ui.mode === "prompt" && items.length > MAX_ROWS) {
    start = items.length - MAX_ROWS;
  }
  if (start > 0) {
    rows.push([{ text: fit(`  ${start} more above`, inner), dim: true }]);
  }
  for (const { kind, item } of items.slice(start, start + MAX_ROWS)) {
    const badge = badgeOf(kind, reason !== undefined && host.editingId !== item.id);
    if (ui.mode === "edit" && ui.edit?.id === item.id) {
      const label = "edit ";
      const view = editorView(ui.edit.editor, {
        kind: "wrapped",
        columns: Math.max(1, textColumns - label.length),
        rows: 4,
      });
      cursor = {
        x: BADGE_WIDTH + label.length + view.cursor.column,
        y: rows.length + view.cursor.row,
      };
      view.rows.forEach((text, index) => {
        rows.push([
          ...(index === 0 ? badgeSegs(badge) : [{ text: " ".repeat(BADGE_WIDTH) }]),
          { text: index === 0 ? label : " ".repeat(label.length), color: "blue" },
          { text: fit(text, textColumns - label.length), color: "blue" },
        ]);
      });
      continue;
    }
    if (ui.mode === "queue" && ui.selected === item.id) {
      wrap(item.text, textColumns).forEach((line, index) => {
        rows.push([
          ...(index === 0 ? badgeSegs(badge) : [{ text: " ".repeat(BADGE_WIDTH) }]),
          { text: fit(line, textColumns), inverse: true },
        ]);
      });
      continue;
    }
    const lines = item.text.split("\n");
    const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
    rows.push([
      ...badgeSegs(badge),
      { text: fit(`${lines[0] ?? ""}${more}`, textColumns), dim: true },
    ]);
  }
  const below = items.length - start - MAX_ROWS;
  if (below > 0) {
    rows.push([{ text: fit(`  ${below} more below`, inner), dim: true }]);
  }
  return { rows, cursor };
}

function dot(row: SessionRow): Seg {
  if (row.current) {
    return { text: "●", color: "green" };
  }
  if (row.held) {
    return { text: "●", color: "yellow" };
  }
  if (row.cutOff) {
    return { text: "●", color: "red" };
  }
  if (row.damaged || row.newer) {
    return { text: "✕", dim: true };
  }
  return { text: "○", dim: true };
}

function pickerD(ui: Ui, host: FakeCodingAgent, inner: number, height: number): Seg[][] {
  const nameColumns = Math.max(16, inner - 2 - 17 - 10 - 30);
  const rows: Seg[][] = [[{ text: `Resume a Session in ${REPO} · newest first` }], []];
  host.sessions.forEach((row, index) => {
    const selected = index === ui.picker.index;
    const faded = row.held !== undefined || row.damaged === true || row.newer === true;
    const tasks =
      row.tasks === undefined ? "?" : `${row.tasks} ${row.tasks === 1 ? "task" : "tasks"}`;
    const text = ` ${fit(row.name, nameColumns)}${fit(row.lastActivity, 17)}${fit(tasks, 10)}${sessionStatus(row)}`;
    rows.push([
      dot(row),
      { text: fit(text, inner - 1), inverse: selected, dim: faded && !selected },
    ]);
  });
  while (rows.length < height) {
    rows.push([]);
  }
  return rows.slice(0, height);
}

export function composeD(
  ui: Ui,
  host: FakeCodingAgent,
  columns: number,
  screenRows: number,
  director: Row,
): Screen {
  const inner = Math.max(1, columns - 4);
  const top = border(
    ["╭", "╮"],
    [{ text: ` ${host.sessionName} · ${REPO} ` }],
    [runState(host)],
    columns,
  );
  const counts = `${host.steers.length} steer · ${host.followUps.length} next`;
  const bottom = border(
    ["╰", "╯"],
    ui.notice
      ? [{ text: ` ${ui.notice} `, color: "yellow" }]
      : [{ text: ` ${hintD(ui, host)} `, dim: true }],
    [{ text: ` ${counts} `, dim: true }],
    columns,
  );
  const promptActive = ui.mode === "prompt";
  const prompt = editorView(ui.prompt, {
    kind: "wrapped",
    columns: Math.max(1, inner - width(MARKER)),
    rows: Math.max(1, Math.floor(screenRows * 0.3)),
  });
  const promptRows: Row[] = prompt.rows.map((text, index) =>
    framed(
      [
        {
          text: prompt.firstRow + index === 0 ? MARKER : "  ",
          color: promptActive ? "blue" : undefined,
          dim: !promptActive,
        },
        { text: fit(text, inner - width(MARKER)), dim: !promptActive },
      ],
      inner,
    ),
  );
  const strip = ui.mode === "picker" ? { rows: [] as Seg[][] } : stripD(ui, host, inner);
  const stripRows = strip.rows.length > 0 ? [...strip.rows.map((segs) => framed(segs, inner))] : [];
  // Director, top border, body, separator, strip and its separator, Prompt, bottom border.
  const chrome = 1 + 1 + 1 + (stripRows.length > 0 ? stripRows.length + 1 : 0) + 1;
  const body = Math.max(0, screenRows - chrome - promptRows.length);
  let bodyRows: Row[];
  if (ui.mode === "picker") {
    bodyRows = pickerD(ui, host, inner, body).map((segs) => framed(segs, inner));
  } else {
    const laidOut = transcriptRows(host.transcript, inner);
    const first = topRow(laidOut, body, ui.position);
    bodyRows = laidOut
      .slice(first, first + body)
      .map((row) => framed([{ text: fit(row.text, inner) }], inner));
    while (bodyRows.length < body) {
      bodyRows.unshift(framed([], inner));
    }
  }
  const rows: Row[] = [director, top, ...bodyRows, separator(columns)];
  let cursor: { x: number; y: number } | undefined;
  if (stripRows.length > 0) {
    if (strip.cursor !== undefined) {
      cursor = { x: 2 + strip.cursor.x, y: rows.length + strip.cursor.y };
    }
    rows.push(...stripRows, separator(columns));
  }
  const promptTop = rows.length;
  rows.push(...promptRows, bottom);
  if (promptActive) {
    cursor = { x: 2 + width(MARKER) + prompt.cursor.column, y: promptTop + prompt.cursor.row };
  }
  return { rows, cursor, transcriptHeight: body };
}
