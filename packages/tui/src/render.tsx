import { render } from "ink";
import { Transcript } from "@/transcript";
import type { TuiHandle, TuiHandlers, TuiModel } from "@/types";

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
  instance.rerender(<Transcript model={props.model} />);

  let unmounted: Promise<void> | undefined;
  return {
    update(model) {
      // Ink would mount the tree again if it rendered after unmount.
      if (unmounted === undefined) {
        instance.rerender(<Transcript model={model} />);
      }
    },
    unmount() {
      unmounted ??= (async () => {
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
