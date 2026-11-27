import { EventEmitter } from "node:events";
import { useInput, usePaste, useStdin, useStdout } from "ink";
import { useEffect, useRef } from "react";
import type { KeyPress } from "./input.ts";

// Report button events without pointer motion, using SGR encoding for the button and cell.
const ENABLE_MOUSE = "\u001b[?1006h\u001b[?1000h";
const DISABLE_MOUSE = "\u001b[?1000l\u001b[?1006l";
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC distinguishes a report from text.
const MOUSE_REPORT = /^(\u001b)?\u001b\[<(\d{1,3});\d+;\d+([Mm])$/;
const MOUSE_MODIFIERS = 0b11100;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

export type WheelDirection = -1 | 1;

// Capture input only when both streams are terminals. In particular, a TUI with piped output
// leaves Ctrl+C to the terminal instead of enabling raw mode on a blank screen.
export function useTerminalInput({
  interactive,
  onKey,
  onPaste,
  onWheel,
}: {
  interactive: boolean;
  onKey(text: string, key: KeyPress): void;
  onPaste(text: string): void;
  onWheel(direction: WheelDirection): void;
}): void {
  const stdin = useStdin();
  const { stdout } = useStdout();
  const takesInput = interactive && stdin.isRawModeSupported === true;
  // Ink 7.1.1 frames complete CSI sequences, then useInput strips their ESC prefix. Read the
  // same event before that normalization so text resembling a mouse report still reaches onKey.
  // Mouse reporting stays off if a future Ink version removes this internal emitter.
  const inputEvents =
    "internal_eventEmitter" in stdin && stdin.internal_eventEmitter instanceof EventEmitter
      ? stdin.internal_eventEmitter
      : undefined;
  const rawInput = useRef("");

  useInput(
    (text, key) => {
      const report = MOUSE_REPORT.exec(rawInput.current);
      if (report === null) {
        onKey(text, key);
        return;
      }
      const [, leadingEscape, encodedButton, pressOrRelease] = report;
      // Ink can group a bare Escape with the following CSI when they arrive together.
      if (leadingEscape !== undefined) onKey("", { escape: true });
      const button = Number(encodedButton) & ~MOUSE_MODIFIERS;
      if (pressOrRelease === "M" && (button === WHEEL_UP || button === WHEEL_DOWN)) {
        onWheel(button === WHEEL_UP ? -1 : 1);
      }
    },
    { isActive: takesInput },
  );
  usePaste(onPaste, { isActive: takesInput });
  useEffect(() => {
    if (!takesInput || inputEvents === undefined) return;
    const rememberInput = (input: string) => {
      rawInput.current = input;
    };
    let reporting = true;
    const stopReporting = () => {
      if (!reporting) return;
      reporting = false;
      try {
        if (stdout.writable) stdout.write(DISABLE_MOUSE);
      } catch {
        // The stream may close during process shutdown. Ink still needs to restore raw mode.
      }
    };
    inputEvents.prependListener("input", rememberInput);
    inputEvents.on("beforeRawModeDisable", stopReporting);
    // Bun can skip Ink's exit handler on an uncaught exception. A monitor leaves the default
    // error reporting and exit status in place while giving the terminal its mouse modes back.
    process.on("uncaughtExceptionMonitor", stopReporting);
    stdout.write(ENABLE_MOUSE);
    return () => {
      process.off("uncaughtExceptionMonitor", stopReporting);
      inputEvents.off("beforeRawModeDisable", stopReporting);
      inputEvents.off("input", rememberInput);
      stopReporting();
    };
  }, [takesInput, inputEvents, stdout]);
}
