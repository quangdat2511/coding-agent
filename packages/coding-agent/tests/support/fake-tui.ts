// A stand-in for the Full-screen TUI: it records every model it is given and hands the test the
// handlers the host registered, so a test presses keys by calling them.
import type { TuiHandle, TuiHandlers, TuiModel } from "@coding-agent/tui";

export interface FakeTui {
  readonly render: (props: { model: TuiModel; handlers: TuiHandlers }) => TuiHandle;
  readonly mounted: () => boolean;
  readonly handlers: () => TuiHandlers;
  readonly latest: () => TuiModel;
  // The model at the moment of unmount, undefined while the TUI is up.
  readonly unmountedWith: () => TuiModel | undefined;
  readonly updates: () => number;
}

// `onUpdate` runs after the model is recorded, and a throw from it is a draw that failed.
export function fakeTui(onUpdate?: (model: TuiModel, count: number) => void): FakeTui {
  let registered: TuiHandlers | undefined;
  let mounted = false;
  let latest: TuiModel = { transcript: [] };
  let atUnmount: TuiModel | undefined;
  let count = 0;
  return {
    render({ model, handlers }) {
      registered = handlers;
      mounted = true;
      latest = model;
      return {
        update(next) {
          latest = next;
          onUpdate?.(next, ++count);
        },
        async unmount() {
          atUnmount = latest;
        },
      };
    },
    mounted: () => mounted,
    handlers() {
      if (registered === undefined) throw new Error("the TUI was never mounted");
      return registered;
    },
    latest: () => latest,
    unmountedWith: () => atUnmount,
    updates: () => count,
  };
}

export async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}
