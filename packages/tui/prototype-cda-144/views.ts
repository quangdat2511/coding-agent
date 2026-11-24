// PROTOTYPE (CDA-144), throwaway. Lays out one frame as styled rows for each variant:
//   A "Rows": one strip row per item, selection walks the strip, edit happens in the row.
//   B "Summary + panel": a one- or two-row summary, a bordered panel over the transcript to manage
//     items, a boxed session picker with a filter.
//   C "Prompt recall": one ruled row, Up recalls items into the Prompt like shell history, the
//     session picker is a split list with a preview.
import stringWidth from "string-width";
import { type Editor, type EditorView, editorView } from "../src/editor.ts";
import { TASK_MARKER, transcriptRows, wrap } from "../src/rows.ts";
import { type ScrollPosition, topRow } from "../src/viewport.ts";
import { type FakeCodingAgent, type QueueKind, REPO, type SessionRow } from "./host.ts";
import { composeD } from "./variant-d.ts";

export type Variant = "A" | "B" | "C" | "D";
export const VARIANTS: readonly Variant[] = ["A", "B", "C", "D"];
export const VARIANT_NAMES: Record<Variant, string> = {
  A: "Rows",
  B: "Summary + panel",
  C: "Prompt recall",
  D: "Framed",
};
export type Platform = "unix" | "windows";
export type Mode = "prompt" | "queue" | "edit" | "picker" | "echo";

export interface EchoRecord {
  readonly raw: string;
  readonly report: string;
  readonly chord: string;
  readonly action: string;
}

export interface Ui {
  variant: Variant;
  platform: Platform;
  mode: Mode;
  prompt: Editor;
  // C: the draft put aside while a queued item is recalled into the Prompt.
  draft: Editor | undefined;
  edit: { id: string; editor: Editor } | undefined;
  selected: string | undefined;
  picker: { index: number; filter: string };
  confirm: { kind: "quit" | "new" | "open"; at: number; target?: string } | undefined;
  notice: string | undefined;
  position: ScrollPosition;
  echo: EchoRecord[];
  seen: Set<string>;
  kitty: "on" | "not answered";
  // D: key hints in macOS symbols rather than words.
  symbols: boolean;
}

export interface Seg {
  readonly text: string;
  readonly inverse?: boolean;
  readonly dim?: boolean;
  readonly bold?: boolean;
  readonly color?: string;
  readonly bg?: string;
}
export type Row = Seg[];

export interface Screen {
  rows: Row[];
  cursor: { x: number; y: number } | undefined;
  transcriptHeight: number;
}

export function keyNames(platform: Platform) {
  return platform === "unix"
    ? { followUp: "Alt+Enter", dequeue: "Alt+Up", newLine: "Shift+Enter/Ctrl+J" }
    : { followUp: "Ctrl+Q", dequeue: "Alt+Q", newLine: "Ctrl+Enter/Ctrl+J" };
}

const KIND_LABEL: Record<QueueKind, string> = { steer: "Steering", followUp: "Follow-up" };

export function width(text: string): number {
  return stringWidth(text);
}

// Cut to `columns` with an ellipsis, then pad to exactly `columns`.
export function fit(text: string, columns: number): string {
  if (columns <= 0) {
    return "";
  }
  let out = text.replace(/\n/g, " ");
  if (width(out) > columns) {
    while (width(out) > columns - 1) {
      out = out.slice(0, -1);
    }
    out += "…";
  }
  return out + " ".repeat(Math.max(0, columns - width(out)));
}

function firstLine(text: string): string {
  const lines = text.split("\n");
  return lines.length > 1 ? `${lines[0]} (+${lines.length - 1} lines)` : text;
}

const plain = (text: string, columns: number): Row => [{ text: fit(text, columns) }];
const dim = (text: string, columns: number): Row => [{ text: fit(text, columns), dim: true }];
const inv = (text: string, columns: number): Row => [{ text: fit(text, columns), inverse: true }];

export function visibleSessions(ui: Ui, host: FakeCodingAgent): SessionRow[] {
  if (ui.variant !== "B" || ui.picker.filter === "") {
    return host.sessions;
  }
  const filter = ui.picker.filter.toLowerCase();
  return host.sessions.filter((row) => row.name.toLowerCase().includes(filter));
}

export function sessionStatus(row: SessionRow): string {
  if (row.current) {
    return "this Session";
  }
  if (row.held) {
    return `open in another terminal (PID ${row.held.pid})`;
  }
  if (row.damaged) {
    return "damaged, cannot resume";
  }
  if (row.newer) {
    return "made by a newer Coding Agent";
  }
  if (row.cutOff) {
    return "last run cut off";
  }
  return "";
}

function tasksText(row: SessionRow): string {
  if (row.tasks === undefined) {
    return "?";
  }
  return row.tasks === 1 ? "1 task" : `${row.tasks} tasks`;
}

// The labelled editor rows of a queued item being edited, and where its cursor goes.
function editorRows(
  label: string,
  editor: Editor,
  columns: number,
  maxRows: number,
): { rows: string[]; view: EditorView } {
  const view = editorView(editor, {
    kind: "wrapped",
    columns: Math.max(1, columns - width(label)),
    rows: maxRows,
  });
  const indent = " ".repeat(width(label));
  return {
    rows: view.rows.map((text, index) => (index === 0 ? label : indent) + text),
    view,
  };
}

export function hint(ui: Ui, host: FakeCodingAgent): string {
  const keys = keyNames(ui.platform);
  const running = host.run !== undefined;
  const queued = host.items().length > 0;
  switch (ui.mode) {
    case "echo":
      return "Press the chords to test · Ctrl+C leaves the key echo";
    case "picker":
      return ui.variant === "B"
        ? "Enter open · Up/Down move · type to filter · Esc close"
        : "Enter open · Up/Down move · Esc close";
    case "edit":
      return `Enter save · ${keys.newLine} new line · Esc keep the old text`;
    case "queue":
      if (ui.variant === "C") {
        return `Up/Down next item · type to edit · Enter save · ${keys.followUp} send now · Ctrl+D delete · Esc back to draft`;
      }
      return "Enter send now · e edit · d delete · Up/Down move · Esc back to Prompt";
    default: {
      const queueKey = queued ? (ui.variant === "B" ? " · Shift+Up queue" : " · Up queue") : "";
      if (running) {
        return `Enter steer · ${keys.followUp} follow-up${queueKey} · Esc cancel run · ${keys.newLine} new line`;
      }
      return `Enter run${queueKey} · Ctrl+R resume · Ctrl+N new Session · ${keys.newLine} new line · Esc twice quit`;
    }
  }
}

function directorRow(ui: Ui, host: FakeCodingAgent, columns: number): Row {
  const platform = ui.platform === "unix" ? "macOS/Linux keys" : "Windows keys";
  const time = host.paused ? "time paused (::play)" : "time running";
  const run = host.run ? `run turn ${host.run.turn}/${host.run.turns}` : "no run";
  return inv(
    ` PROTOTYPE CDA-144 · ${ui.variant} ${VARIANT_NAMES[ui.variant]} · ${platform} · ${run} · ${time} · Tab variant · ::help`,
    columns,
  );
}

function stripRows(
  ui: Ui,
  host: FakeCodingAgent,
  columns: number,
): { rows: Row[]; cursor?: { x: number; y: number } } {
  const items = host.items();
  const reason = host.waitingReason();
  switch (ui.variant) {
    case "D":
      return { rows: [] };
    case "A": {
      const rows: Row[] = [];
      let cursor: { x: number; y: number } | undefined;
      if (reason !== undefined) {
        rows.push(
          plain(
            `Follow-ups wait: ${reason}. Enter runs your own task first; Up, then Enter sends one now.`,
            columns,
          ),
        );
      }
      const max = 6;
      const selectedIndex = Math.max(
        0,
        items.findIndex((entry) => entry.item.id === ui.selected),
      );
      const start =
        items.length <= max ? 0 : Math.min(Math.max(0, selectedIndex - 2), items.length - max);
      if (start > 0) {
        rows.push(dim(`  ${start} more above`, columns));
      }
      for (const { kind, item } of items.slice(start, start + max)) {
        const label = `${KIND_LABEL[kind]}: `;
        if (ui.mode === "edit" && ui.edit?.id === item.id) {
          const edited = editorRows(`Editing ${label}`, ui.edit.editor, columns, 3);
          cursor = {
            x: width(`Editing ${label}`) + edited.view.cursor.column,
            y: rows.length + edited.view.cursor.row,
          };
          rows.push(...edited.rows.map((text) => plain(text, columns)));
        } else if (ui.mode === "queue" && ui.selected === item.id) {
          rows.push(inv(`${label}${firstLine(item.text)}`, columns));
        } else {
          rows.push(dim(`${label}${firstLine(item.text)}`, columns));
        }
      }
      const below = items.length - start - max;
      if (below > 0) {
        rows.push(dim(`  ${below} more below`, columns));
      }
      return { rows, cursor };
    }
    case "B": {
      const rows: Row[] = [];
      const steers = items.filter((entry) => entry.kind === "steer");
      const followUps = items.filter((entry) => entry.kind === "followUp");
      if (steers[0] !== undefined) {
        const more = steers.length > 1 ? `  (+${steers.length - 1})` : "";
        rows.push(
          dim(`Steering (${steers.length}): ${firstLine(steers[0].item.text)}${more}`, columns),
        );
      }
      if (followUps[0] !== undefined) {
        const more = followUps.length > 1 ? `  (+${followUps.length - 1})` : "";
        const why = reason === undefined ? "" : `  · waiting: ${reason}`;
        const text = `Follow-ups (${followUps.length}): ${firstLine(followUps[0].item.text)}${more}${why}`;
        rows.push(reason === undefined ? dim(text, columns) : plain(text, columns));
      }
      return { rows };
    }
    case "C": {
      if (items.length === 0) {
        return { rows: [] };
      }
      const steers = host.steers.length;
      const followUps = host.followUps.length;
      let text: string;
      if (ui.mode === "queue" && ui.edit !== undefined) {
        const index = items.findIndex((entry) => entry.item.id === ui.edit?.id);
        const entry = items[index];
        text = `── ${entry ? KIND_LABEL[entry.kind] : "Item"} ${index + 1} of ${items.length} is in the Prompt; nothing takes it while it is shown `;
      } else {
        const parts = [
          steers > 0 ? `${steers} Steering` : undefined,
          followUps > 0 ? `${followUps} Follow-up${followUps > 1 ? "s" : ""}` : undefined,
        ].filter(Boolean);
        const why = reason === undefined ? "" : ` · waiting: ${reason}`;
        text = `── Prompt Queue: ${parts.join(" · ")}${why} · Up recalls `;
      }
      return { rows: [dim(text + "─".repeat(Math.max(0, columns - width(text))), columns)] };
    }
  }
}

function promptMarker(ui: Ui, host: FakeCodingAgent): string {
  if (ui.variant === "C" && ui.mode === "queue" && ui.edit !== undefined) {
    const items = host.items();
    const index = items.findIndex((entry) => entry.item.id === ui.edit?.id);
    const entry = items[index];
    return entry ? `${KIND_LABEL[entry.kind]} ${index + 1}/${items.length}> ` : "> ";
  }
  return TASK_MARKER;
}

function boxed(title: string, body: Row[], columns: number): Row[] {
  const inner = Math.max(1, columns - 2);
  const top = `╭─ ${title} `;
  return [
    plain(`${top + "─".repeat(Math.max(0, columns - 1 - width(top)))}╮`, columns),
    ...body
      .map((row): Row => [{ text: "│" }, ...row, { text: "│" }])
      .map((row) => {
        const used = row.reduce((sum, seg) => sum + width(seg.text), 0);
        return used === columns
          ? row
          : [...row.slice(0, -1), { text: fit("", columns - used) }, { text: "│" }];
      }),
    plain(`╰${"─".repeat(inner)}╯`, columns),
  ];
}

function panelB(
  ui: Ui,
  host: FakeCodingAgent,
  columns: number,
  height: number,
): { rows: Row[]; cursor?: { x: number; y: number } } {
  const inner = columns - 2;
  const body: Row[] = [];
  let cursorBody: { x: number; y: number } | undefined;
  const items = host.items();
  const reason = host.waitingReason();
  const section = (kind: QueueKind) => {
    const list = items.filter((entry) => entry.kind === kind);
    if (list.length === 0) {
      return;
    }
    body.push(
      dim(
        kind === "steer"
          ? " Steering · the run takes one before each Model Turn"
          : ` Follow-ups · ${reason === undefined ? "the next starts after a run succeeds" : `waiting: ${reason}`}`,
        inner,
      ),
    );
    for (const { item } of list) {
      const number = items.findIndex((entry) => entry.item.id === item.id) + 1;
      const text = `  ${number}  ${firstLine(item.text)}${host.editingId === item.id ? "  (editing)" : ""}`;
      body.push(ui.selected === item.id ? inv(text, inner) : plain(text, inner));
    }
  };
  section("steer");
  section("followUp");
  body.push(dim(` ${"─".repeat(inner - 2)} `, inner));
  const selected = items.find((entry) => entry.item.id === ui.selected);
  if (ui.mode === "edit" && ui.edit !== undefined) {
    const edited = editorRows(" Edit: ", ui.edit.editor, inner, 4);
    cursorBody = {
      x: 1 + width(" Edit: ") + edited.view.cursor.column,
      y: body.length + edited.view.cursor.row,
    };
    body.push(...edited.rows.map((text) => plain(text, inner)));
  } else if (selected !== undefined) {
    for (const line of wrap(selected.item.text, inner - 2).slice(0, 4)) {
      body.push(plain(` ${line}`, inner));
    }
  }
  const all = boxed("Prompt Queue", body, columns);
  const rows = all.slice(-height);
  const cut = all.length - rows.length;
  // Relative to the panel's first row: the top border is row 0 of `all`.
  return {
    rows,
    cursor: cursorBody === undefined ? undefined : { x: cursorBody.x, y: 1 + cursorBody.y - cut },
  };
}

function pickerA(ui: Ui, host: FakeCodingAgent, columns: number, height: number): Row[] {
  const sessions = visibleSessions(ui, host);
  const nameColumns = Math.max(16, columns - 62);
  const head = `  ${fit("NAME", nameColumns)}  ${fit("LAST ACTIVITY", 16)}  ${fit("TASKS", 8)}  STATUS`;
  const rows: Row[] = [
    [
      {
        text: fit(
          ` Resume a Session in ${REPO} · ${sessions.length} Sessions, newest first`,
          columns,
        ),
        bold: true,
      },
    ],
    dim(head, columns),
  ];
  sessions.forEach((row, index) => {
    const text = `  ${fit(row.name, nameColumns)}  ${fit(row.lastActivity, 16)}  ${fit(tasksText(row), 8)}  ${sessionStatus(row)}`;
    if (index === ui.picker.index) {
      rows.push(inv(text, columns));
    } else if (row.held || row.damaged || row.newer) {
      rows.push(dim(text, columns));
    } else {
      rows.push(plain(text, columns));
    }
  });
  while (rows.length < height) {
    rows.push(plain("", columns));
  }
  return rows.slice(0, height);
}

function pickerB(ui: Ui, host: FakeCodingAgent, columns: number, height: number): Row[] {
  const inner = columns - 2;
  const sessions = visibleSessions(ui, host);
  const body: Row[] = [
    plain(` Filter: ${ui.picker.filter}`, inner),
    dim(` ${"─".repeat(inner - 2)} `, inner),
  ];
  sessions.forEach((row, index) => {
    const selected = index === ui.picker.index;
    const faded = row.held || row.damaged || row.newer;
    const name = ` ${row.current ? "* " : "  "}${row.name}`;
    const meta = `     ${[row.lastActivity, tasksText(row), sessionStatus(row)].filter(Boolean).join(" · ")}`;
    body.push(selected ? inv(name, inner) : faded ? dim(name, inner) : plain(name, inner));
    body.push(selected ? inv(meta, inner) : dim(meta, inner));
  });
  if (sessions.length === 0) {
    body.push(dim("   No Session matches", inner));
  }
  return boxed(`Resume a Session in ${REPO}`, body, columns).slice(0, height);
}

function pickerC(ui: Ui, host: FakeCodingAgent, columns: number, height: number): Row[] {
  const sessions = visibleSessions(ui, host);
  const left = Math.max(20, Math.floor(columns * 0.4));
  const right = columns - left - 3;
  const selected = sessions[ui.picker.index];
  const preview: Row[] = [];
  if (selected !== undefined) {
    preview.push([{ text: fit(selected.name, right), bold: true }]);
    preview.push(dim(`${selected.lastActivity} · ${tasksText(selected)}`, right));
    const status = sessionStatus(selected);
    if (status !== "") {
      preview.push(plain(status, right));
    }
    preview.push(plain("", right));
    for (const line of selected.preview) {
      preview.push(dim(line, right));
    }
    if (selected.preview.length === 0 && !selected.current) {
      preview.push(dim("(nothing to show)", right));
    }
  }
  const rows: Row[] = [[{ text: fit(` Resume a Session in ${REPO}`, columns), bold: true }]];
  for (let index = 0; index < height - 1; index += 1) {
    const row = sessions[index];
    let leftRow: Row;
    if (row === undefined) {
      leftRow = plain("", left);
    } else {
      const text = ` ${row.current ? "* " : "  "}${row.name}`;
      const faded = row.held || row.damaged || row.newer;
      leftRow =
        index === ui.picker.index ? inv(text, left) : faded ? dim(text, left) : plain(text, left);
    }
    rows.push([...leftRow, { text: " │ ", dim: true }, ...(preview[index] ?? plain("", right))]);
  }
  return rows;
}

function echoRows(ui: Ui, columns: number, height: number): Row[] {
  const chords = [
    "Alt+Enter",
    "Shift+Enter",
    "Ctrl+Enter",
    "Ctrl+J",
    "Alt+Up",
    "Shift+Up",
    "Ctrl+Up",
    "Ctrl+Q",
    "Alt+Q",
    "Ctrl+N",
    "Ctrl+R",
    "Esc",
  ];
  const checklist = chords
    .map((chord) => `${ui.seen.has(chord) ? "[x]" : "[ ]"} ${chord}`)
    .join("  ");
  const rows: Row[] = [
    [
      {
        text: fit(
          ` Key echo · kitty keyboard protocol: ${ui.kitty} · reading with ${ui.platform === "unix" ? "macOS/Linux" : "Windows"} keys`,
          columns,
        ),
        bold: true,
      },
    ],
    ...wrap(checklist, columns - 1).map((line) => plain(` ${line}`, columns)),
    plain("", columns),
    dim(
      ` ${fit("BYTES", 18)} ${fit("INK REPORTS", 24)} ${fit("CHORD", 26)} THE PROTOTYPE DOES`,
      columns,
    ),
  ];
  for (const record of ui.echo.slice(-(height - rows.length))) {
    rows.push(
      plain(
        ` ${fit(record.raw, 18)} ${fit(record.report, 24)} ${fit(record.chord, 26)} ${record.action}`,
        columns,
      ),
    );
  }
  while (rows.length < height) {
    rows.push(plain("", columns));
  }
  return rows.slice(0, height);
}

export function compose(
  ui: Ui,
  host: FakeCodingAgent,
  columns: number,
  screenRows: number,
): Screen {
  const director = directorRow(ui, host, columns);
  if (ui.variant === "D" && ui.mode !== "echo") {
    return composeD(ui, host, columns, screenRows, director);
  }
  const hintRow: Row = ui.notice
    ? [{ text: fit(ui.notice, columns), bold: true }]
    : dim(hint(ui, host), columns);

  if (ui.mode === "echo") {
    return {
      rows: [director, ...echoRows(ui, columns, screenRows - 2), hintRow],
      cursor: undefined,
      transcriptHeight: 0,
    };
  }

  const marker = promptMarker(ui, host);
  const promptEditor =
    ui.variant === "C" && ui.mode === "queue" && ui.edit ? ui.edit.editor : ui.prompt;
  const prompt = editorView(promptEditor, {
    kind: "wrapped",
    columns: Math.max(1, columns - width(marker)),
    rows: Math.max(1, Math.floor(screenRows * 0.3)),
  });
  const continuation = " ".repeat(width(marker));
  const promptActive = ui.mode === "prompt" || (ui.variant === "C" && ui.mode === "queue");
  const promptRows: Row[] = prompt.rows.map((text, index) => {
    const line = (prompt.firstRow + index === 0 ? marker : continuation) + text;
    return promptActive ? plain(line, columns) : dim(line, columns);
  });

  const strip =
    ui.mode === "picker" && ui.variant !== "B" ? { rows: [] } : stripRows(ui, host, columns);
  const region = Math.max(0, screenRows - 2 - promptRows.length);
  const transcriptHeight = Math.max(0, region - strip.rows.length);

  let regionRows: Row[];
  let cursor: { x: number; y: number } | undefined;
  if (ui.mode === "picker" && ui.variant === "A") {
    regionRows = pickerA(ui, host, columns, region);
  } else if (ui.mode === "picker" && ui.variant === "C") {
    regionRows = pickerC(ui, host, columns, region);
  } else {
    const laidOut = transcriptRows(host.transcript, columns);
    const top = topRow(laidOut, transcriptHeight, ui.position);
    const transcript: Row[] = laidOut
      .slice(top, top + transcriptHeight)
      .map((row) => plain(row.text, columns));
    while (transcript.length < transcriptHeight) {
      transcript.push(plain("", columns));
    }
    if (ui.variant === "B" && (ui.mode === "queue" || ui.mode === "edit") && transcriptHeight > 0) {
      const panel = panelB(ui, host, columns, transcriptHeight);
      transcript.splice(transcriptHeight - panel.rows.length, panel.rows.length, ...panel.rows);
      if (panel.cursor !== undefined) {
        cursor = {
          x: panel.cursor.x,
          y: 1 + transcriptHeight - panel.rows.length + panel.cursor.y,
        };
      }
    }
    if (ui.variant === "B" && ui.mode === "picker" && transcriptHeight > 0) {
      const box = pickerB(ui, host, columns, transcriptHeight);
      transcript.splice(transcriptHeight - box.length, box.length, ...box);
      // The filter is the first row inside the box.
      cursor = {
        x: 1 + width(" Filter: ") + width(ui.picker.filter),
        y: 1 + transcriptHeight - box.length + 1,
      };
    }
    regionRows = [...transcript, ...strip.rows];
    if (strip.cursor !== undefined) {
      cursor = { x: strip.cursor.x, y: 1 + transcriptHeight + strip.cursor.y };
    }
  }

  if (promptActive) {
    cursor = {
      x: width(marker) + prompt.cursor.column,
      y: 1 + region + prompt.cursor.row,
    };
  }
  if (ui.mode === "picker" && ui.variant !== "B") {
    cursor = undefined;
  }
  if (ui.mode === "queue" && ui.variant !== "C") {
    cursor = undefined;
  }

  return {
    rows: [director, ...regionRows, ...promptRows, hintRow],
    cursor,
    transcriptHeight,
  };
}
