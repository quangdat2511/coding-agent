import { render } from "ink";
import { type EditorLayout, EMPTY_EDITOR, edit, editorView } from "./editor.ts";
import { Frame, frameLayout, maxPromptRows, type OverlayProps } from "./frame.tsx";
import {
  type InputState,
  inputMode,
  type KeyAction,
  type KeyPress,
  QUIET_MS,
  routeKey,
  routePaste,
} from "./input.ts";
import { canAllow, overlayGeometry } from "./overlay.tsx";
import { sessionViewRows, TASK_MARKER } from "./rows.ts";
import type { TuiHandle, TuiHandlers, TuiModel } from "./types.ts";
import { FOLLOWING, pageRows, positionAt, type ScrollPosition, topRow } from "./viewport.ts";

// The terminal the TUI draws on: the process's own streams in renderTui, streams backed by
// @xterm/headless in tests. Node's stream types keep Ink out of this signature.
export interface TuiStreams {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
}

// What renderTui sets for the process's terminal and tests set for theirs.
export interface TuiOptions {
  // The clock that tells whether a key comes after a pause. Tests move one by hand.
  readonly now?: () => number;
  // Whether to ask the terminal for the kitty keyboard protocol, under which Ink tells Shift+Enter
  // from Enter. Ink asks only a terminal on both streams, waits up to 200 ms for its answer, and
  // turns the protocol off again on unmount.
  readonly kittyKeyboard?: boolean;
}

export interface MountedTui extends TuiHandle {
  // Resolves once every frame requested so far has been written to stdout. Ink throttles frames,
  // so the frame for an update() may still be pending when update() returns.
  flush(): Promise<void>;
  // Moves the viewport by `rows` terminal rows: negative toward older entries, positive toward the
  // newest. Page Up and Page Down move it a page at a time along the same path; tests that need an
  // exact number of rows scroll through here.
  scrollBy(rows: number): void;
}

// Ink's alternateScreen sends only ESC[?1049h, which leaves the cursor on the row where the shell
// left it. Moving it to the top-left corner makes the Session view start on the first row.
const CURSOR_HOME = "\u001b[H";
const WHEEL_ROWS = 3;

export function renderTui(props: { model: TuiModel; handlers: TuiHandlers }): TuiHandle {
  const streams = { stdout: process.stdout, stdin: process.stdin };
  const { update, unmount } = mountTui(props, streams, { kittyKeyboard: true });
  return { update, unmount };
}

export function mountTui(
  props: { model: TuiModel; handlers: TuiHandlers },
  streams: TuiStreams,
  options: TuiOptions = {},
): MountedTui {
  const { handlers } = props;
  const now = options.now ?? Date.now;
  let model = props.model;
  let position: ScrollPosition = FOLLOWING;
  // The text typed, kept here rather than in a component because the rows the Prompt takes decide
  // the rows the Session view gets.
  let input: InputState = { prompt: EMPTY_EDITOR };
  // When the keyboard was last used or an Approval last appeared. A decision counts only once the
  // keyboard has been quiet for QUIET_MS since then, so a y or n typed for the Prompt as the
  // overlay opens decides nothing.
  let lastActivity = now();
  let unmounted: Promise<void> | undefined;
  let instance: ReturnType<typeof render> | undefined;

  // How the screen is shared out for the terminal's current size and the text typed so far.
  function measure() {
    // Ink also assumes 80x24 when the stream reports no size.
    const columns = streams.stdout.columns || 80;
    const screenRows = streams.stdout.rows || 24;
    const promptLayout: EditorLayout = {
      kind: "wrapped",
      columns: Math.max(1, columns - TASK_MARKER.length),
      rows: maxPromptRows(screenRows),
    };
    const prompt = editorView(input.prompt, promptLayout);
    const frame = frameLayout(screenRows, prompt.rows.length);
    const overlay = overlayGeometry(columns, frame.sessionViewHeight);
    const reasonLayout: EditorLayout = { kind: "row", columns: overlay.reasonColumns };
    return { columns, promptLayout, prompt, frame, overlay, reasonLayout };
  }

  // Lays the Session view out for the current terminal size, moves the viewport by `scroll` rows
  // and draws only the rows that fit above the Prompt, so the frame is never taller than the
  // screen.
  function draw(scroll = 0) {
    // Ink would mount the tree again if it rendered after unmount.
    if (unmounted !== undefined || instance === undefined) {
      return;
    }
    const { columns, prompt, frame, overlay, reasonLayout } = measure();
    const viewportHeight = frame.sessionViewHeight;
    const rows = sessionViewRows(model.sessionView, columns);
    // With no Session view row in view there is nothing to scroll. Moving would anchor the viewport
    // out of sight, and once the terminal grew it would not follow new rows.
    if (viewportHeight > 0) {
      position = positionAt(rows, viewportHeight, topRow(rows, viewportHeight, position) + scroll);
    }
    const top = topRow(rows, viewportHeight, position);
    const approval = model.pendingApproval;
    const mode = inputMode(input, approval);
    const reason =
      mode === "reason" && input.reason !== undefined
        ? editorView(input.reason.editor, reasonLayout)
        : undefined;
    const overlayProps: OverlayProps | undefined =
      mode === "prompt" || approval === undefined
        ? undefined
        : { approval, geometry: overlay, reason };
    let cursor: { x: number; y: number } | undefined;
    if (mode === "prompt") {
      cursor = {
        x: TASK_MARKER.length + prompt.cursor.column,
        y: frame.sessionViewHeight + prompt.cursor.row,
      };
    } else if (reason !== undefined && overlay.height > 0) {
      cursor = { x: overlay.reasonOrigin.x + reason.cursor.column, y: overlay.reasonOrigin.y };
    }
    instance.rerender(
      <Frame
        rows={rows.slice(top, top + viewportHeight)}
        layout={frame}
        columns={columns}
        prompt={prompt}
        mode={mode}
        overlay={overlayProps}
        cursor={cursor}
        interactive={interactive}
        onKey={(text: string, key: KeyPress) => perform(routeKey(currentMode(), text, key))}
        onPaste={(text: string) => perform(routePaste(currentMode(), text))}
        onWheel={(direction) => draw(direction * WHEEL_ROWS)}
      />,
    );
  }

  function currentMode() {
    return inputMode(input, model.pendingApproval);
  }

  // Carries out the actions of one key press or paste in order, reading the mode again for each:
  // Ink can deliver n and the reason typed after it before the frame is drawn again.
  function perform(actions: readonly KeyAction[]) {
    const quiet = now() - lastActivity >= QUIET_MS;
    lastActivity = now();
    let scroll = 0;
    for (const action of actions) {
      const { promptLayout, frame, overlay, reasonLayout } = measure();
      const approval = model.pendingApproval;
      const mode = inputMode(input, approval);
      switch (action.kind) {
        case "insert":
        case "backspace":
        case "delete":
        case "move":
          if (mode === "reason" && input.reason !== undefined) {
            const editor = edit(input.reason.editor, action, reasonLayout);
            input = { ...input, reason: { ...input.reason, editor } };
          } else if (mode === "prompt") {
            input = { ...input, prompt: edit(input.prompt, action, promptLayout) };
          }
          break;
        case "submit":
          if (mode === "reason") {
            denyWithReason();
          } else if (mode === "prompt") {
            submitTask();
          }
          break;
        case "scroll":
          scroll += action.direction * pageRows(frame.sessionViewHeight);
          break;
        // Whether a task is running is the host's to know: it ignores a cancel with none. The
        // Prompt keeps its text, which may be the next task.
        case "cancel":
          handlers.onCancel();
          break;
        case "allow":
          if (mode === "approval" && approval !== undefined && quiet && canAllow(overlay)) {
            input = { ...input, decided: approval.approvalId };
            handlers.onApproval(approval.approvalId, "allow");
          }
          break;
        case "deny":
          if (mode === "approval" && approval !== undefined && quiet) {
            input = { ...input, reason: { approvalId: approval.approvalId, editor: EMPTY_EDITOR } };
          }
          break;
        default: {
          const unhandled: never = action;
          throw new Error(`Unhandled key action: ${JSON.stringify(unhandled)}`);
        }
      }
    }
    draw(scroll);
  }

  // Spaces and line breaks around the task, such as the empty line a pasted line break leaves,
  // are not part of it, and a Prompt of only spaces has no Coding Task to start; Enter clears the
  // Prompt either way. Input methods may send a letter composed or as a base and combining marks;
  // NFC sends the same text in one form. The state changes before the handler runs, so a host
  // that updates the model from inside it draws the cleared Prompt.
  function submitTask() {
    const task = input.prompt.text.trim();
    input = { ...input, prompt: EMPTY_EDITOR };
    if (task !== "") {
      handlers.onSubmit(task.normalize("NFC"));
    }
  }

  // A reason of only spaces is no reason, so the denial goes without one.
  function denyWithReason() {
    if (input.reason === undefined) {
      return;
    }
    const { approvalId, editor } = input.reason;
    const reason = editor.text.trim().normalize("NFC");
    input = { ...input, decided: approvalId, reason: undefined };
    if (reason === "") {
      handlers.onApproval(approvalId, "deny");
    } else {
      handlers.onApproval(approvalId, "deny", reason);
    }
  }

  // Added before render() so that it runs before Ink's own resize listener, which redraws the
  // current tree: rows sized for the old terminal could be wider or taller than the new screen.
  const redraw = () => draw();
  streams.stdout.on("resize", redraw);

  // Left to itself, Ink treats any CI environment as non-interactive and draws nothing until
  // unmount. Deciding from isTTY alone renders the same way whether or not CI is set.
  const interactive = Boolean(streams.stdout.isTTY);
  const { stdin, stdout } = streams;
  const enterRawMode = options.kittyKeyboard && interactive && stdin.isTTY && !stdin.isRaw;
  try {
    // Ink sends the kitty query when it creates the renderer. Its input hooks take ownership of
    // raw mode on the first frame. An immediate terminal reply needs raw mode even before that.
    if (enterRawMode) stdin.setRawMode(true);
    // An empty tree enters the alternate screen without drawing anything, so the cursor can be
    // moved before the first frame.
    instance = render(null, {
      stdout,
      stdin,
      interactive,
      alternateScreen: true,
      incrementalRendering: true,
      maxFps: 60,
      // Ctrl+C is a cancel key in the input policy. Left on, Ink would exit on it before the policy
      // saw the key.
      exitOnCtrlC: false,
      kittyKeyboard: options.kittyKeyboard ? { mode: "auto" } : undefined,
    });
    if (interactive) stdout.write(CURSOR_HOME);
    draw();
  } catch (error) {
    stdout.off("resize", redraw);
    try {
      instance?.unmount();
    } finally {
      if (enterRawMode && stdin.isRaw) stdin.setRawMode(false);
    }
    throw error;
  }

  const mounted = instance;
  return {
    update(next) {
      // A new Approval restarts the wait for a quiet keyboard, so a key already on its way when
      // the overlay opens decides nothing.
      const approvalId = next.pendingApproval?.approvalId;
      if (approvalId !== undefined && approvalId !== model.pendingApproval?.approvalId) {
        lastActivity = now();
      }
      model = next;
      draw();
    },
    scrollBy(rows) {
      draw(rows);
    },
    unmount() {
      unmounted ??= (async () => {
        streams.stdout.off("resize", redraw);
        // waitUntilExit() adds a beforeExit listener that only unmount() removes, so it goes first.
        const exited = mounted.waitUntilExit();
        mounted.unmount();
        await exited;
      })();
      return unmounted;
    },
    flush: () => mounted.waitUntilRenderFlush(),
  };
}
