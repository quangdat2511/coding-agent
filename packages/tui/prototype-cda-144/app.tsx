// PROTOTYPE (CDA-144), throwaway. Mounts the variants on the real TUI pieces (transcript rows,
// editor, viewport, Ink setup) with a fake Coding Agent behind them. No tests, no polish.
import type { EventEmitter } from "node:events";
import { Box, render, Text, useCursor, useInput, usePaste, useStdin } from "ink";
import { useEffect } from "react";
import { type Editor, type EditorLayout, EMPTY_EDITOR, edit, editorView } from "../src/editor.ts";
import { type KeyAction, type KeyPress, routeKey, routePaste } from "../src/input.ts";
import { transcriptRows } from "../src/rows.ts";
import { FOLLOWING, pageRows, positionAt, topRow } from "../src/viewport.ts";
import { FakeCodingAgent, type SessionRow } from "./host.ts";
import { applyScene, HELP, SCENES } from "./scenes.ts";
import {
  compose,
  type EchoRecord,
  type Platform,
  type Screen,
  type Ui,
  VARIANTS,
  type Variant,
  visibleSessions,
  width,
} from "./views.ts";

export interface Key extends KeyPress {
  readonly tab?: boolean;
}

export interface Streams {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
}

export interface AppOptions {
  readonly variant: Variant;
  readonly platform: Platform;
  readonly scene?: string;
  readonly kitty: boolean;
  // Live runs tick and quit the process; snapshots do neither.
  readonly live: boolean;
}

export interface App {
  readonly ui: Ui;
  readonly host: FakeCodingAgent;
  command(text: string): void;
  enterQueue(id?: string): void;
  beginEdit(id: string): void;
  openPicker(index?: number): void;
  flush(): Promise<void>;
  unmount(): Promise<void>;
}

const atEnd = (text: string): Editor => ({ text, cursor: text.length, start: 0 });

const isCtrl = (input: string, key: Key, letter: string) =>
  key.ctrl === true && input.toLowerCase() === letter;
const isAlt = (input: string, key: Key, letter: string) =>
  key.meta === true && key.ctrl !== true && input.toLowerCase() === letter;
const isPlainEnter = (key: Key) => key.return === true && !key.shift && !key.meta && !key.ctrl;

function isFollowUpKey(platform: Platform, input: string, key: Key): boolean {
  return platform === "unix" ? key.return === true && key.meta === true : isCtrl(input, key, "q");
}

function isDequeueKey(platform: Platform, input: string, key: Key): boolean {
  return platform === "unix" ? key.upArrow === true && key.meta === true : isAlt(input, key, "q");
}

function isNewLine(input: string, key: Key): boolean {
  return (
    (key.return === true && (key.shift === true || key.ctrl === true)) ||
    input === "\n" ||
    isCtrl(input, key, "j")
  );
}

export function mountApp(streams: Streams, options: AppOptions): App {
  const ui: Ui = {
    variant: options.variant,
    platform: options.platform,
    mode: "prompt",
    prompt: EMPTY_EDITOR,
    draft: undefined,
    edit: undefined,
    selected: undefined,
    picker: { index: 0, filter: "" },
    confirm: undefined,
    notice: undefined,
    position: FOLLOWING,
    echo: [],
    seen: new Set(),
    kitty: "not answered",
  };
  let screen: Screen | undefined;
  let unmounted: Promise<void> | undefined;

  const host = new FakeCodingAgent(() => {
    const selected = ui.selected;
    if (selected !== undefined && ui.mode === "queue" && host.find(selected) === undefined) {
      ui.notice =
        host.gone.get(selected) === "started"
          ? "The Follow-up you selected just started"
          : "The run just took the Steer you selected";
    }
    if (ui.mode === "queue" && host.items().length === 0) {
      leaveQueue();
    }
    draw();
  });

  const size = () => ({
    columns: streams.stdout.columns || 80,
    rows: streams.stdout.rows || 24,
  });

  function promptLayout(marker = "> "): EditorLayout {
    const { columns, rows } = size();
    return {
      kind: "wrapped",
      columns: Math.max(1, columns - width(marker)),
      rows: Math.max(1, Math.floor(rows * 0.3)),
    };
  }

  function editLayout(): EditorLayout {
    const { columns } = size();
    if (ui.variant === "B") {
      return { kind: "wrapped", columns: Math.max(1, columns - 2 - width(" Edit: ")), rows: 4 };
    }
    if (ui.variant === "C") {
      return promptLayout("Follow-up 1/1> ");
    }
    const kind = ui.edit === undefined ? undefined : host.find(ui.edit.id)?.kind;
    const label = `Editing ${kind === "steer" ? "Steering" : "Follow-up"}: `;
    return { kind: "wrapped", columns: Math.max(1, columns - width(label)), rows: 3 };
  }

  function draw() {
    if (unmounted !== undefined) {
      return;
    }
    const { columns, rows } = size();
    screen = compose(ui, host, columns, rows);
    instance.rerender(
      <Frame
        screen={screen}
        interactive={interactive}
        onKey={onKey}
        onPaste={onPaste}
        onRaw={onRaw}
      />,
    );
  }

  function scroll(direction: -1 | 1) {
    const { columns } = size();
    const height = screen?.transcriptHeight ?? 0;
    if (height === 0) {
      return;
    }
    const laidOut = transcriptRows(host.transcript, columns);
    ui.position = positionAt(
      laidOut,
      height,
      topRow(laidOut, height, ui.position) + direction * pageRows(height),
    );
  }

  // --- director -------------------------------------------------------------------------------

  function command(text: string) {
    const [name = "", ...rest] = text.trim().split(/\s+/);
    const lower = name.toLowerCase();
    if (lower === "help" || lower === "") {
      host.transcript.push({ kind: "notice", id: `help-${Date.now()}`, text: HELP });
      ui.position = FOLLOWING;
    } else if (lower === "a" || lower === "b" || lower === "c") {
      setVariant(lower.toUpperCase() as Variant);
    } else if (lower === "win" || lower === "windows") {
      ui.platform = "windows";
    } else if (lower === "unix" || lower === "mac" || lower === "linux") {
      ui.platform = "unix";
    } else if (lower === "play") {
      host.paused = false;
    } else if (lower === "pause") {
      host.paused = true;
    } else if (lower === "step") {
      host.step();
      host.paused = true;
    } else if (lower === "fail") {
      if (host.run !== undefined) {
        host.run.fails = true;
        ui.notice = "The active run will fail at its last Model Turn";
      }
    } else if (lower === "echo") {
      ui.mode = "echo";
    } else if (lower in SCENES) {
      applyScene(lower, app);
    } else {
      ui.notice = `Unknown command ::${[name, ...rest].join(" ")} (::help lists them)`;
    }
  }

  function setVariant(variant: Variant) {
    if (ui.mode === "queue" || ui.mode === "edit") {
      leaveQueue();
    }
    ui.variant = variant;
  }

  // --- modes ----------------------------------------------------------------------------------

  function submit(how: "enter" | "followUp") {
    const text = ui.prompt.text;
    ui.prompt = EMPTY_EDITOR;
    ui.confirm = undefined;
    if (text.trim().startsWith("::")) {
      command(text.trim().slice(2));
      return;
    }
    const notice = host.submit(text.normalize("NFC"), how);
    if (notice !== undefined) {
      ui.notice = notice;
    }
    ui.position = FOLLOWING;
  }

  function quit() {
    const now = Date.now();
    const count = host.followUps.length;
    if (ui.confirm?.kind === "quit" && now - ui.confirm.at < 2000) {
      if (options.live) {
        void unmount().then(() => process.exit(0));
      } else {
        ui.notice = "(the prototype would quit here)";
      }
      return;
    }
    ui.confirm = { kind: "quit", at: now };
    ui.notice =
      count > 0
        ? `Quit discards ${count} waiting Follow-up${count > 1 ? "s" : ""}. Press again to quit.`
        : "Press again to quit.";
  }

  function newSession() {
    if (host.run !== undefined) {
      ui.notice = "Finish or cancel the running task before starting a new Session";
      return;
    }
    const now = Date.now();
    const count = host.followUps.length;
    if (count > 0 && !(ui.confirm?.kind === "new" && now - ui.confirm.at < 3000)) {
      ui.confirm = { kind: "new", at: now };
      ui.notice = `A new Session discards ${count} waiting Follow-up${count > 1 ? "s" : ""}. Press Ctrl+N again to start it.`;
      return;
    }
    const old = host.sessionName;
    ui.confirm = undefined;
    host.newSession();
    ui.position = FOLLOWING;
    ui.notice =
      old === "(new Session)"
        ? "New Session"
        : `New Session. "${old}" is in the resume list (Ctrl+R).`;
  }

  function openPicker(index = 1) {
    if (host.run !== undefined) {
      ui.notice = "Finish or cancel the running task before resuming another Session";
      return;
    }
    ui.mode = "picker";
    ui.picker = { index, filter: "" };
    ui.confirm = undefined;
  }

  function openSession(row: SessionRow) {
    if (row.current) {
      ui.notice = "This is the Session you are in";
    } else if (row.held !== undefined) {
      ui.notice = `"${row.name}" is open in another terminal (PID ${row.held.pid}). Close it there first.`;
    } else if (row.losesRace) {
      row.held = { pid: 5151 };
      ui.notice = `"${row.name}" was just opened in another terminal (PID 5151)`;
    } else if (row.damaged) {
      ui.notice = "This session file is damaged: it is listed but cannot be resumed";
    } else if (row.newer) {
      ui.notice = "A newer Coding Agent made this Session: update to resume it";
    } else {
      const count = host.followUps.length;
      const now = Date.now();
      const confirmed =
        ui.confirm?.kind === "open" && ui.confirm.target === row.id && now - ui.confirm.at < 3000;
      if (count > 0 && !confirmed) {
        ui.confirm = { kind: "open", at: now, target: row.id };
        ui.notice = `Resuming discards ${count} waiting Follow-up${count > 1 ? "s" : ""}. Press Enter again to resume.`;
        return;
      }
      ui.confirm = undefined;
      host.resume(row);
      ui.mode = "prompt";
      ui.position = FOLLOWING;
      ui.notice = `Resumed "${row.name}"`;
    }
  }

  function enterQueue(id?: string) {
    const items = host.items();
    const target = id ?? items.at(-1)?.item.id;
    if (target === undefined) {
      return;
    }
    if (ui.variant === "C") {
      ui.draft = ui.prompt;
      recall(target);
    } else {
      ui.selected = target;
    }
    ui.mode = "queue";
  }

  function recall(id: string) {
    const found = host.find(id);
    const notice = host.beginEdit(id);
    if (notice !== undefined || found === undefined) {
      ui.notice = notice;
      return;
    }
    ui.selected = id;
    ui.edit = { id, editor: atEnd(found.item.text) };
  }

  // C: lets go of the recalled item, keeping changed text.
  function release() {
    if (ui.edit === undefined) {
      return;
    }
    const original = host.find(ui.edit.id)?.item.text;
    if (original !== undefined && ui.edit.editor.text !== original) {
      const notice = host.saveEdit(ui.edit.id, ui.edit.editor.text);
      if (notice !== undefined) {
        ui.notice = notice;
        host.endEdit();
      }
    } else {
      host.endEdit();
    }
    ui.edit = undefined;
  }

  function leaveQueue() {
    if (ui.variant === "C") {
      release();
      ui.prompt = ui.draft ?? ui.prompt;
      ui.draft = undefined;
    } else if (ui.edit !== undefined) {
      host.endEdit();
      ui.edit = undefined;
    }
    ui.selected = undefined;
    ui.mode = "prompt";
  }

  function beginEdit(id: string) {
    if (ui.variant === "C") {
      enterQueue(id);
      return;
    }
    const notice = host.beginEdit(id);
    const found = host.find(id);
    if (notice !== undefined || found === undefined) {
      ui.notice = notice;
      return;
    }
    ui.selected = id;
    ui.edit = { id, editor: atEnd(found.item.text) };
    ui.mode = "edit";
  }

  function dequeue() {
    if (ui.variant === "C" && ui.mode === "queue") {
      leaveQueue();
    }
    const texts = host.dequeueAll();
    if (texts.length === 0) {
      ui.notice = "Nothing is queued";
      return;
    }
    const draft = ui.prompt.text;
    ui.prompt = atEnd([...texts, ...(draft === "" ? [] : [draft])].join("\n"));
    ui.mode = "prompt";
    ui.edit = undefined;
    ui.selected = undefined;
    ui.notice = `Moved ${texts.length} queued item${texts.length > 1 ? "s" : ""} into the Prompt`;
  }

  function editText(target: "prompt" | "edit", action: KeyAction) {
    if (
      action.kind !== "insert" &&
      action.kind !== "backspace" &&
      action.kind !== "delete" &&
      action.kind !== "move"
    ) {
      return;
    }
    if (target === "prompt") {
      ui.prompt = edit(ui.prompt, action, promptLayout());
    } else if (ui.edit !== undefined) {
      ui.edit = { ...ui.edit, editor: edit(ui.edit.editor, action, editLayout()) };
    }
  }

  function promptOnFirstRow(): boolean {
    const view = editorView(ui.prompt, promptLayout());
    return view.firstRow + view.cursor.row === 0;
  }

  function promptKey(input: string, key: Key) {
    const running = host.run !== undefined;
    if (key.escape || isCtrl(input, key, "c")) {
      if (running) {
        host.cancel();
        ui.notice = "Cancelled the run";
      } else {
        quit();
      }
      return;
    }
    if (isFollowUpKey(ui.platform, input, key)) {
      submit("followUp");
      return;
    }
    if (isDequeueKey(ui.platform, input, key)) {
      dequeue();
      return;
    }
    if (isCtrl(input, key, "n")) {
      newSession();
      return;
    }
    if (isCtrl(input, key, "r")) {
      openPicker();
      return;
    }
    const intoQueue =
      key.upArrow === true &&
      !key.meta &&
      !key.ctrl &&
      (key.shift === true || (ui.variant !== "B" && promptOnFirstRow()));
    if (intoQueue && host.items().length > 0) {
      enterQueue();
      return;
    }
    if (isNewLine(input, key)) {
      editText("prompt", { kind: "insert", text: "\n" });
      return;
    }
    for (const action of routeKey("prompt", input, key)) {
      if (action.kind === "submit") {
        submit("enter");
      } else if (action.kind === "scroll") {
        scroll(action.direction);
      } else {
        editText("prompt", action);
      }
    }
  }

  function queueKey(input: string, key: Key) {
    const items = host.items();
    const index = items.findIndex((entry) => entry.item.id === ui.selected);
    const id = ui.selected;
    if (isCtrl(input, key, "c")) {
      if (host.cancel()) {
        ui.notice = "Cancelled the run";
      }
      return;
    }
    if (key.escape) {
      leaveQueue();
      return;
    }
    if (isDequeueKey(ui.platform, input, key)) {
      dequeue();
      return;
    }
    if (key.upArrow) {
      ui.selected = items[Math.max(0, index - 1)]?.item.id;
      return;
    }
    if (key.downArrow) {
      if (index >= items.length - 1) {
        if (ui.variant === "A") {
          leaveQueue();
        }
        return;
      }
      ui.selected = items[index + 1]?.item.id;
      return;
    }
    if (id === undefined) {
      return;
    }
    const reselect = () => {
      const after = host.items();
      if (host.find(id) === undefined) {
        ui.selected = after[Math.min(Math.max(0, index), after.length - 1)]?.item.id;
      }
      if (after.length === 0) {
        leaveQueue();
      }
    };
    if (key.return) {
      ui.notice = host.sendNow(id);
      ui.position = FOLLOWING;
      reselect();
    } else if (input === "e") {
      beginEdit(id);
    } else if (input === "d" || key.delete || key.backspace) {
      ui.notice = host.remove(id);
      reselect();
    }
  }

  function editKey(input: string, key: Key) {
    const current = ui.edit;
    if (current === undefined) {
      ui.mode = "queue";
      return;
    }
    if (isCtrl(input, key, "c")) {
      if (host.cancel()) {
        ui.notice = "Cancelled the run; the item stays in edit";
      }
      return;
    }
    if (key.escape) {
      host.endEdit();
      ui.edit = undefined;
      ui.mode = "queue";
      ui.notice = "Edit abandoned: the text is unchanged";
      return;
    }
    if (isNewLine(input, key) || (key.return === true && key.meta === true)) {
      editText("edit", { kind: "insert", text: "\n" });
      return;
    }
    if (isPlainEnter(key)) {
      const notice = host.saveEdit(current.id, current.editor.text);
      if (notice !== undefined) {
        ui.notice = notice;
        return;
      }
      ui.edit = undefined;
      ui.mode = "queue";
      ui.notice = "Saved in place";
      return;
    }
    for (const action of routeKey("prompt", input, key)) {
      editText("edit", action);
    }
  }

  // C: the recalled item is in the Prompt and typing edits it.
  function recallKey(input: string, key: Key) {
    const current = ui.edit;
    if (current === undefined) {
      leaveQueue();
      return;
    }
    const items = host.items();
    const index = items.findIndex((entry) => entry.item.id === current.id);
    const view = editorView(current.editor, editLayout());
    if (isCtrl(input, key, "c")) {
      if (host.cancel()) {
        ui.notice = "Cancelled the run";
      }
      return;
    }
    if (key.escape) {
      host.endEdit();
      ui.edit = undefined;
      ui.prompt = ui.draft ?? EMPTY_EDITOR;
      ui.draft = undefined;
      ui.selected = undefined;
      ui.mode = "prompt";
      return;
    }
    if (isFollowUpKey(ui.platform, input, key)) {
      release();
      ui.notice = host.sendNow(current.id);
      leaveQueue();
      return;
    }
    if (isCtrl(input, key, "d")) {
      host.endEdit();
      ui.edit = undefined;
      ui.notice = host.remove(current.id);
      const next = host.items()[Math.min(index, host.items().length - 1)];
      if (next === undefined) {
        leaveQueue();
      } else {
        recall(next.item.id);
      }
      return;
    }
    if (key.upArrow && !key.meta && view.firstRow + view.cursor.row === 0) {
      const previous = items[index - 1];
      if (previous !== undefined) {
        release();
        recall(previous.item.id);
      }
      return;
    }
    const lastRow = wrapRowsCount(current.editor) - 1;
    if (key.downArrow && view.firstRow + view.cursor.row >= lastRow) {
      const next = items[index + 1];
      release();
      if (next === undefined) {
        leaveQueue();
      } else {
        recall(next.item.id);
      }
      return;
    }
    if (isNewLine(input, key)) {
      editText("edit", { kind: "insert", text: "\n" });
      return;
    }
    if (isPlainEnter(key)) {
      release();
      leaveQueue();
      ui.notice = "Saved in place";
      return;
    }
    for (const action of routeKey("prompt", input, key)) {
      editText("edit", action);
    }
  }

  function wrapRowsCount(editor: Editor): number {
    const layout = editLayout();
    const tall = editorView({ ...editor, cursor: editor.text.length }, {
      ...layout,
      rows: 1000,
    } as EditorLayout);
    return tall.firstRow + tall.rows.length;
  }

  function pickerKey(input: string, key: Key) {
    const sessions = visibleSessions(ui, host);
    if (key.escape || isCtrl(input, key, "c")) {
      ui.mode = "prompt";
      ui.confirm = undefined;
      return;
    }
    if (key.upArrow) {
      ui.picker.index = Math.max(0, ui.picker.index - 1);
      ui.confirm = undefined;
      return;
    }
    if (key.downArrow) {
      ui.picker.index = Math.min(sessions.length - 1, ui.picker.index + 1);
      ui.confirm = undefined;
      return;
    }
    if (key.return) {
      const row = sessions[ui.picker.index];
      if (row !== undefined) {
        openSession(row);
      }
      return;
    }
    if (ui.variant === "B") {
      if (key.backspace || key.delete) {
        ui.picker = { index: 0, filter: ui.picker.filter.slice(0, -1) };
      } else if (
        !key.ctrl &&
        !key.meta &&
        input !== "" &&
        ![...input].some((char) => (char.codePointAt(0) ?? 0) < 0x20)
      ) {
        ui.picker = { index: 0, filter: ui.picker.filter + input };
      }
    }
  }

  // --- key echo -------------------------------------------------------------------------------

  let pendingRaw: string | undefined;
  let pendingKey: { input: string; key: Key } | undefined;
  let echoScheduled = false;

  function scheduleEcho() {
    if (echoScheduled) {
      return;
    }
    echoScheduled = true;
    queueMicrotask(() => {
      echoScheduled = false;
      const raw = pendingRaw ?? "";
      const pressed = pendingKey;
      pendingRaw = undefined;
      pendingKey = undefined;
      if (ui.mode !== "echo" || pressed === undefined) {
        return;
      }
      const record = echoRecord(raw, pressed.input, pressed.key, ui.platform);
      ui.echo = [...ui.echo, record].slice(-200);
      ui.seen.add(record.chord === LF_CHORD ? "Ctrl+J" : record.chord);
      draw();
    });
  }

  function onRaw(data: string) {
    if (data.startsWith("\u001b") && /^\[\?\d+u$/.test(data.slice(1))) {
      ui.kitty = "on";
    }
    pendingRaw = data;
    scheduleEcho();
  }

  // --- input ----------------------------------------------------------------------------------

  function onKey(input: string, key: Key) {
    if (/^\[\?\d+u$/.test(input)) {
      ui.kitty = "on";
      draw();
      return;
    }
    if (ui.mode === "echo") {
      if (isCtrl(input, key, "c")) {
        ui.mode = "prompt";
        draw();
        return;
      }
      pendingKey = { input, key };
      scheduleEcho();
      return;
    }
    ui.notice = undefined;
    if (key.tab) {
      const at = VARIANTS.indexOf(ui.variant);
      const next = VARIANTS[(at + (key.shift ? VARIANTS.length - 1 : 1)) % VARIANTS.length];
      if (next !== undefined) {
        setVariant(next);
      }
      draw();
      return;
    }
    if (key.pageUp || key.pageDown) {
      scroll(key.pageUp ? -1 : 1);
      draw();
      return;
    }
    switch (ui.mode) {
      case "prompt":
        promptKey(input, key);
        break;
      case "queue":
        if (ui.variant === "C") {
          recallKey(input, key);
        } else {
          queueKey(input, key);
        }
        break;
      case "edit":
        editKey(input, key);
        break;
      case "picker":
        pickerKey(input, key);
        break;
      default:
        break;
    }
    draw();
  }

  function onPaste(text: string) {
    if (ui.mode === "prompt") {
      for (const action of routePaste("prompt", text)) {
        editText("prompt", action);
      }
    } else if (ui.mode === "edit" || (ui.mode === "queue" && ui.variant === "C")) {
      for (const action of routePaste("prompt", text)) {
        editText("edit", action);
      }
    }
    draw();
  }

  const redraw = () => draw();
  streams.stdout.on("resize", redraw);
  const interactive = Boolean(streams.stdout.isTTY);
  const instance = render(null, {
    stdout: streams.stdout,
    stdin: streams.stdin,
    interactive,
    alternateScreen: true,
    incrementalRendering: true,
    maxFps: 60,
    exitOnCtrlC: false,
    kittyKeyboard: options.kitty ? { mode: "auto" } : undefined,
  });
  if (interactive) {
    streams.stdout.write("\u001b[H");
  }

  function unmount(): Promise<void> {
    unmounted ??= (async () => {
      host.stop();
      streams.stdout.off("resize", redraw);
      const exited = instance.waitUntilExit();
      instance.unmount();
      await exited;
    })();
    return unmounted;
  }

  const app: App = {
    ui,
    host,
    command: (text) => {
      command(text);
      draw();
    },
    enterQueue,
    beginEdit,
    openPicker,
    flush: () => instance.waitUntilRenderFlush(),
    unmount,
  };

  if (options.scene !== undefined) {
    applyScene(options.scene, app);
  }
  if (options.live) {
    host.start();
  }
  draw();
  return app;
}

function Frame({
  screen,
  interactive,
  onKey,
  onPaste,
  onRaw,
}: {
  screen: Screen;
  interactive: boolean;
  onKey(input: string, key: Key): void;
  onPaste(text: string): void;
  onRaw(data: string): void;
}) {
  const stdin = useStdin() as ReturnType<typeof useStdin> & {
    internal_eventEmitter: EventEmitter;
  };
  const takesInput = interactive && stdin.isRawModeSupported === true;
  useInput(onKey, { isActive: takesInput });
  usePaste(onPaste, { isActive: takesInput });
  const emitter = stdin.internal_eventEmitter;
  useEffect(() => {
    if (!takesInput) {
      return;
    }
    emitter.on("input", onRaw);
    return () => {
      emitter.off("input", onRaw);
    };
  }, [takesInput, emitter, onRaw]);
  const { setCursorPosition } = useCursor();
  // Same off-by-one as src/frame.tsx: a frame that fills the screen ends without a newline.
  setCursorPosition(
    screen.cursor === undefined ? undefined : { x: screen.cursor.x, y: screen.cursor.y + 1 },
  );
  return (
    <Box flexDirection="column" height={screen.rows.length}>
      {screen.rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are laid out again each frame
        <Text key={index} wrap="truncate-end">
          {row.map((seg, part) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are laid out again each frame
              key={part}
              inverse={seg.inverse}
              dimColor={seg.dim}
              bold={seg.bold}
            >
              {seg.text === "" ? " " : seg.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

// --- key echo helpers -----------------------------------------------------------------------

const LF_CHORD = "LF: Ctrl+J, or Ctrl+Enter on Windows";

function showBytes(raw: string): string {
  return [...raw]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0x1b) {
        return "ESC";
      }
      if (code < 0x20) {
        return `^${String.fromCharCode(code + 64)}`;
      }
      if (code === 0x7f) {
        return "DEL";
      }
      return char;
    })
    .join(" ");
}

function chordOf(input: string, key: Key): string {
  const mods = [key.ctrl && "Ctrl", key.meta && "Alt", key.shift && "Shift"].filter(Boolean);
  const named = key.return
    ? "Enter"
    : key.escape
      ? "Esc"
      : key.upArrow
        ? "Up"
        : key.downArrow
          ? "Down"
          : key.leftArrow
            ? "Left"
            : key.rightArrow
              ? "Right"
              : key.tab
                ? "Tab"
                : key.backspace
                  ? "Backspace"
                  : key.delete
                    ? "Delete"
                    : key.pageUp
                      ? "PgUp"
                      : key.pageDown
                        ? "PgDn"
                        : undefined;
  if (named !== undefined) {
    return [...mods, named].join("+");
  }
  if (input === "\n") {
    return LF_CHORD;
  }
  if (input.length === 1 && /[a-z]/i.test(input)) {
    const shiftless = mods.filter((mod) => !(mod === "Shift" && /[A-Z]/.test(input)));
    return [...shiftless, input.toUpperCase()].join("+");
  }
  if (input.length === 1 && /[^\x20-\x7e]/.test(input)) {
    return `"${input}" (composed by Option?)`;
  }
  return [...mods, JSON.stringify(input)].join("+");
}

function reportOf(input: string, key: Key): string {
  const flags = Object.entries(key)
    .filter(([name, value]) => value === true && name !== "eventType")
    .map(([name]) => name);
  return [input === "" ? "" : JSON.stringify(input), ...flags].filter(Boolean).join(" ");
}

function actionOf(platform: Platform, input: string, key: Key): string {
  if (key.escape || isCtrl(input, key, "c")) {
    return "cancel the run, or quit";
  }
  if (isFollowUpKey(platform, input, key)) {
    return "queue a Follow-up";
  }
  if (isDequeueKey(platform, input, key)) {
    return "all queued items back to the Prompt";
  }
  const other: Platform = platform === "unix" ? "windows" : "unix";
  const otherName = other === "unix" ? "macOS/Linux" : "Windows";
  if (isFollowUpKey(other, input, key)) {
    return `nothing here; Follow-up with ${otherName} keys`;
  }
  if (isDequeueKey(other, input, key)) {
    return `nothing here; dequeue with ${otherName} keys`;
  }
  if (isCtrl(input, key, "n")) {
    return "new Session";
  }
  if (isCtrl(input, key, "r")) {
    return "open the resume list";
  }
  if (key.upArrow && key.shift) {
    return "enter the Prompt Queue";
  }
  if (key.upArrow && !key.meta && !key.ctrl) {
    return "Prompt row up, or into the queue from row 1";
  }
  if (isNewLine(input, key)) {
    return "new line";
  }
  if (isPlainEnter(key)) {
    return "submit (a Steer while a run is active)";
  }
  if (key.ctrl || key.meta) {
    return "nothing";
  }
  return "typed";
}

function echoRecord(raw: string, input: string, key: Key, platform: Platform): EchoRecord {
  return {
    raw: showBytes(raw),
    report: reportOf(input, key),
    chord: chordOf(input, key),
    action: actionOf(platform, input, key),
  };
}
