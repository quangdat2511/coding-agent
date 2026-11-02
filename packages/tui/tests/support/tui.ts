import { FOOTER_HEIGHT } from "../../src/frame.tsx";
import { type MountedTui, mountTui, type TuiOptions, type TuiStreams } from "../../src/render.tsx";
import type { TuiHandlers, TuiModel } from "../../src/types.ts";
import type { TestTerminal } from "./terminal.ts";

// A handler that the keys a test presses never reach.
export function unexpectedHandlerCall(): never {
  throw new Error("The TUI called a handler this test does not expect");
}

const UNEXPECTED_HANDLERS: TuiHandlers = {
  onSubmit: unexpectedHandlerCall,
  onCancel: unexpectedHandlerCall,
  onApproval: unexpectedHandlerCall,
};

const mounted: { tui: MountedTui; terminal: TestTerminal }[] = [];

// Mounts the TUI on `terminal`. `streams` stands in for its stdin or stdout, as when input or
// output is piped. A test mounts one TUI: each Ink instance patches console, and patch-console
// saves the methods it replaces in one place for every instance, so with two TUIs mounted at once
// console is left without its methods after both unmount, which breaks the test files after it.
export function mountOn(
  terminal: TestTerminal,
  model: TuiModel,
  handlers: TuiHandlers = UNEXPECTED_HANDLERS,
  streams: Partial<TuiStreams> = {},
  options: TuiOptions = {},
): MountedTui {
  if (mounted.length > 0) {
    throw new Error("A TUI is already mounted in this test");
  }
  const tui = mountTui({ model, handlers }, { ...terminal.streams, ...streams }, options);
  mounted.push({ tui, terminal });
  return tui;
}

// Unmounts the TUI a test mounted and disposes of its terminal. Each test file runs it after each
// test.
export async function unmountTui(): Promise<void> {
  for (const { tui, terminal } of mounted.splice(0)) {
    await tui.unmount();
    terminal.dispose();
  }
}

// A clock the test moves by hand, so a key comes after a pause only when the test says so.
export function manualClock(): { now(): number; advance(ms: number): void } {
  let time = 0;
  return {
    now: () => time,
    advance(ms) {
      time += ms;
    },
  };
}

// The Prompt's row, the first of the rows under the transcript, while the Prompt has one row.
export function prompt(terminal: TestTerminal): string | undefined {
  return terminal.screen().at(-FOOTER_HEIGHT);
}

// The rows of the viewport, above the Prompt and the key hint, while the Prompt has one row.
export function viewport(terminal: TestTerminal): string[] {
  return terminal.screen().slice(0, -FOOTER_HEIGHT);
}
