import { render } from "ink";
import { App, FOOTER_HEIGHT } from "./app.tsx";
import { transcriptRows } from "./rows.ts";
import type { TuiHandle, TuiHandlers, TuiModel } from "./types.ts";
import { FOLLOWING, positionAt, type ScrollPosition, topRow } from "./viewport.ts";

// The terminal the TUI draws on: the process's own streams in renderTui, streams backed by
// @xterm/headless in tests. Node's stream types keep Ink out of this signature.
export interface TuiStreams {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
}

export interface MountedTui extends TuiHandle {
  // Resolves once every frame requested so far has been written to stdout. Ink throttles frames,
  // so the frame for an update() may still be pending when update() returns.
  flush(): Promise<void>;
  // Moves the viewport by `rows` terminal rows: negative toward older entries, positive toward the
  // newest. Scroll keys arrive with input routing (CDA-54); until then tests scroll through here.
  scrollBy(rows: number): void;
}

// Ink's alternateScreen sends only ESC[?1049h, which leaves the cursor on the row where the shell
// left it. Moving it to the top-left corner makes the transcript start on the first row.
const CURSOR_HOME = "\u001b[H";

export function renderTui(props: { model: TuiModel; handlers: TuiHandlers }): TuiHandle {
  const { update, unmount } = mountTui(props, { stdout: process.stdout, stdin: process.stdin });
  return { update, unmount };
}

export function mountTui(
  props: { model: TuiModel; handlers: TuiHandlers },
  streams: TuiStreams,
): MountedTui {
  let model = props.model;
  let position: ScrollPosition = FOLLOWING;
  let unmounted: Promise<void> | undefined;

  // Lays the transcript out for the current terminal size, moves the viewport by `scroll` rows and
  // draws only the rows that fit above the prompt, so the frame is never taller than the screen.
  function draw(scroll = 0) {
    // Ink would mount the tree again if it rendered after unmount.
    if (unmounted !== undefined) {
      return;
    }
    // Ink also assumes 80x24 when the stream reports no size.
    const columns = streams.stdout.columns || 80;
    const height = Math.max(1, (streams.stdout.rows || 24) - FOOTER_HEIGHT);
    const rows = transcriptRows(model.transcript, columns);
    position = positionAt(rows, height, topRow(rows, height, position) + scroll);
    const top = topRow(rows, height, position);
    instance.rerender(
      <App rows={rows.slice(top, top + height)} height={height} handlers={props.handlers} />,
    );
  }

  // Added before render() so that it runs before Ink's own resize listener, which redraws the
  // current tree: rows sized for the old terminal could be wider or taller than the new screen.
  const redraw = () => draw();
  streams.stdout.on("resize", redraw);

  // Left to itself, Ink treats any CI environment as non-interactive and draws nothing until
  // unmount. Deciding from isTTY alone renders the same way whether or not CI is set.
  const interactive = Boolean(streams.stdout.isTTY);
  // An empty tree enters the alternate screen without drawing anything, so the cursor can be moved
  // before the first frame.
  const instance = render(null, {
    stdout: streams.stdout,
    stdin: streams.stdin,
    interactive,
    alternateScreen: true,
    incrementalRendering: true,
    maxFps: 60,
  });
  if (interactive) {
    streams.stdout.write(CURSOR_HOME);
  }
  draw();

  return {
    update(next) {
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
        const exited = instance.waitUntilExit();
        instance.unmount();
        await exited;
      })();
      return unmounted;
    },
    flush: () => instance.waitUntilRenderFlush(),
  };
}
