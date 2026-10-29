import { type MountedTui, mountTui, type TuiStreams } from "../../src/render.tsx";
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
): MountedTui {
  if (mounted.length > 0) {
    throw new Error("A TUI is already mounted in this test");
  }
  const tui = mountTui({ model, handlers }, { ...terminal.streams, ...streams });
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
