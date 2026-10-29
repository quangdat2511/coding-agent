// The input policy: what each key press or paste does in the TUI. It is the only place that
// decides, so a new mode adds an entry to MODES here instead of key handling in another component.

// Which part of the TUI has the keyboard. The transcript and the Prompt share the only mode today;
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

// What one mode does with a key press and with pasted text.
interface ModePolicy {
  key(input: string, key: KeyPress): readonly KeyAction[];
  paste(text: string): readonly KeyAction[];
}

// Every mode's rules, in one entry each. The record type makes the compiler ask for an entry for a
// new mode, with both its key and its paste rules.
const MODES: Record<InputMode, ModePolicy> = {
  prompt: { key: routePromptKey, paste: insert },
};

// `input` and `key` are what Ink's useInput passes: the typed text, empty for a named key such as
// an arrow, and the flags that name the key.
export function routeKey(mode: InputMode, input: string, key: KeyPress): readonly KeyAction[] {
  // The cancel keys work the same in every mode, because a task can be running in any of them.
  // Ctrl+C reaches the policy because mountTui turns off Ink's exitOnCtrlC.
  if (key.escape || (key.ctrl && input === "c")) {
    return [{ kind: "cancel" }];
  }
  return MODES[mode].key(input, key);
}

// Text the terminal marked as pasted. Ink delivers it in one piece through usePaste, however many
// reads it took, so a line break inside it never acts as Enter.
export function routePaste(mode: InputMode, text: string): readonly KeyAction[] {
  return MODES[mode].paste(text);
}

// Scroll keys go to the viewport and everything else to the Prompt, so neither reaches the other.
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
  // Ink leaves a carriage return inside a chunk of text, and the chunk alone cannot tell keys typed
  // ahead while the TUI was busy from lines pasted without bracketed paste. So a chunk submits at
  // most once, when it ends in Enter, and a line break inside it becomes a space: a paste never
  // starts several Coding Tasks. Typing ahead pays for it. Two tasks typed with Enter before Ink
  // reads them go as one, and an Enter with more typing after it in the chunk submits nothing.
  const enter = /\r\n?$/.exec(input);
  if (enter === null) {
    return insert(input);
  }
  return [...insert(input.slice(0, enter.index)), SUBMIT];
}

// Typed and pasted text alike can carry line breaks and tabs. The Prompt is one row and its text
// goes to onSubmit, so they become spaces, and other control characters are dropped.
function insert(input: string): readonly KeyAction[] {
  const text = input.replace(/\r\n|[\r\n\t]/g, " ").replace(/\p{Cc}/gu, "");
  return text === "" ? [] : [{ kind: "insert", text }];
}
