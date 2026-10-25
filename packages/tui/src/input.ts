// The input policy: what each key press or paste does in the TUI. It is the only place that
// decides, so a new mode adds a branch here instead of key handling in another component.

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

// One step the TUI takes. A key press or paste maps to a list of them, carried out in order: text
// and the Enter typed after it can arrive together, and a key the TUI does not use maps to none.
export type KeyAction =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "backspace" }
  | { readonly kind: "submit" }
  // -1 moves the viewport a page toward older entries, 1 a page toward the newest.
  | { readonly kind: "scroll"; readonly direction: -1 | 1 }
  | { readonly kind: "cancel" };

const SUBMIT: KeyAction = { kind: "submit" };

// `input` and `key` are what Ink's useInput passes: the typed text, empty for a named key such as
// an arrow, and the flags that name the key.
export function routeKey(mode: InputMode, input: string, key: KeyPress): readonly KeyAction[] {
  // The cancel keys work the same in every mode, because a task can be running in any of them.
  // Ctrl+C reaches the policy because mountTui turns off Ink's exitOnCtrlC.
  if (key.escape || (key.ctrl && input === "c")) {
    return [{ kind: "cancel" }];
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

// Text the terminal marked as pasted. Ink delivers it in one piece through usePaste, however many
// reads it took, so a line break inside it never acts as Enter.
export function routePaste(mode: InputMode, text: string): readonly KeyAction[] {
  switch (mode) {
    case "prompt":
      return insert(text);
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled input mode: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Scroll keys go to the viewport and everything else to the prompt, so neither reaches the other.
function routePromptKey(input: string, key: KeyPress): readonly KeyAction[] {
  if (key.return) {
    return [SUBMIT];
  }
  if (key.backspace) {
    return [{ kind: "backspace" }];
  }
  if (key.pageUp) {
    return [{ kind: "scroll", direction: -1 }];
  }
  if (key.pageDown) {
    return [{ kind: "scroll", direction: 1 }];
  }
  if (key.ctrl || key.meta) {
    return [];
  }
  // Ink leaves a carriage return inside a chunk of text, since a paste without bracketed paste
  // arrives the same way. Keys typed while the TUI is busy also reach it as one chunk, Enter
  // included, so each carriage return in typed text submits what comes before it.
  return input
    .split(/\r\n?/)
    .flatMap((line, index) => (index === 0 ? insert(line) : [SUBMIT, ...insert(line)]));
}

// Pasted text keeps its line breaks and tabs. The prompt is one row and its text goes to
// onSubmit, so line breaks and tabs become spaces and other control characters are dropped before
// the prompt keeps the text.
function insert(input: string): readonly KeyAction[] {
  const text = input.replace(/\r\n|[\r\n\t]/g, " ").replace(/\p{Cc}/gu, "");
  return text === "" ? [] : [{ kind: "insert", text }];
}
