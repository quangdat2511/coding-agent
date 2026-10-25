// The input policy: which part of the TUI a key press goes to. It is the only place that decides
// what a key does, so a new mode adds a branch here instead of key handling in another component.

// Which part of the TUI has the keyboard. The transcript and the prompt share the only mode today;
// the Approval overlay (CDA-60) adds its own.
export type InputMode = "prompt";

// The fields of Ink's key report that the policy reads. Declared here so that tests build a key
// press without Ink and this module names no Ink type. Ink's report has every field.
export interface KeyPress {
  readonly escape?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

export type KeyAction =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "submit" }
  // -1 moves the viewport a page toward older entries, 1 a page toward the newest.
  | { readonly kind: "scroll"; readonly direction: -1 | 1 }
  | { readonly kind: "cancel" }
  | { readonly kind: "ignore" };

const IGNORE: KeyAction = { kind: "ignore" };

// `input` and `key` are what Ink's useInput passes: the typed text, empty for a named key such as
// an arrow, and the flags that name the key.
export function routeKey(mode: InputMode, input: string, key: KeyPress): KeyAction {
  // The cancel keys work the same in every mode, because a task can be running in any of them.
  // Ctrl+C reaches the policy because mountTui turns off Ink's exitOnCtrlC.
  if (key.escape || (key.ctrl && input === "c")) {
    return { kind: "cancel" };
  }
  switch (mode) {
    case "prompt":
      return routePromptKey(input, key);
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled input mode: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Scroll keys go to the viewport and everything else to the prompt, so neither reaches the other.
function routePromptKey(input: string, key: KeyPress): KeyAction {
  if (key.return) {
    return { kind: "submit" };
  }
  if (key.backspace) {
    return { kind: "backspace" };
  }
  if (key.pageUp) {
    return { kind: "scroll", direction: -1 };
  }
  if (key.pageDown) {
    return { kind: "scroll", direction: 1 };
  }
  if (key.ctrl || key.meta) {
    return IGNORE;
  }
  const text = promptText(input);
  return text === "" ? IGNORE : { kind: "insert", text };
}

// Text pasted without bracketed paste arrives as one chunk, line breaks and tabs included. The
// prompt is one row and its text goes to onSubmit, so line breaks and tabs become spaces and other
// control characters are dropped before the prompt keeps the text.
function promptText(input: string): string {
  return input.replace(/\r\n|[\r\n\t]/g, " ").replace(/\p{Cc}/gu, "");
}
