import type { EditAction, Editor } from "./editor.ts";
import type { PendingApproval } from "./types.ts";

// The input policy: which mode has the keyboard and what each key press or paste means in it. It
// decides which actions a key stands for, and mountTui carries them out, so a new mode adds an
// entry to MODES here instead of key handling in a component.

// Which part of the TUI has the keyboard. The transcript shares every mode: Page Up and Page Down
// scroll it in each. "prompt" types a Coding Task, "approval" decides the pending Approval and
// "reason" types why it is denied.
export type InputMode = "prompt" | "approval" | "reason";

// Everything the keys change apart from the scroll position.
export interface InputState {
  readonly prompt: Editor;
  // The Approval the person last decided. The overlay closes at once, before the host takes the
  // Approval out of the model, so a second key press cannot decide it again.
  readonly decided?: string;
  // The reason being typed after n, with the Approval it denies. A new Approval has a new
  // identifier, so it opens with no reason and asks for allow or deny again.
  readonly reason?: { readonly approvalId: string; readonly editor: Editor };
}

export function inputMode(state: InputState, approval: PendingApproval | undefined): InputMode {
  if (approval === undefined || approval.approvalId === state.decided) {
    return "prompt";
  }
  return state.reason?.approvalId === approval.approvalId ? "reason" : "approval";
}

// How long the keyboard must have been quiet, since the last key or since the overlay opened,
// for y or n to decide. A person typing for the Prompt when the overlay opens presses keys a few
// hundred milliseconds apart, so their next y or n decides nothing; one who stops to read it
// pauses longer than this before deciding.
export const QUIET_MS = 500;

// The fields of Ink's key report that the policy reads. Declared here so that tests build a key
// press without Ink and this module names no Ink type. Ink's report has every field.
export interface KeyPress {
  readonly escape?: boolean;
  readonly return?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}

// One step the TUI takes. A key press or paste maps to a list of them, carried out in order: text
// and the Enter typed after it can arrive together, and a key the TUI does not use maps to none.
// Edit actions go to the text being typed, the Prompt or the denial reason.
export type KeyAction =
  | EditAction
  | { readonly kind: "submit" }
  // -1 moves the viewport a page toward older entries, 1 a page toward the newest.
  | { readonly kind: "scroll"; readonly direction: -1 | 1 }
  | { readonly kind: "cancel" }
  | { readonly kind: "allow" }
  | { readonly kind: "deny" };

// The keys that decide the pending Approval, as the overlay and the key hint name them.
export const ALLOW_KEY = "y";
export const DENY_KEY = "n";

// The terminal's answer when Ink asks for the kitty keyboard protocol, CSI ? flags u. Ink 7.1.1
// reads it to turn the protocol on but also passes it to useInput, without its escape character,
// as if it were typed.
const KITTY_QUERY_ANSWER = /^\[\?\d+u$/;

const SUBMIT: KeyAction = { kind: "submit" };
const NEW_LINE: KeyAction = { kind: "insert", text: "\n" };

// What one mode does with a key press and with pasted text.
interface ModePolicy {
  key(input: string, key: KeyPress): readonly KeyAction[];
  paste(text: string): readonly KeyAction[];
}

// The text being typed: the Prompt holds lines, the denial reason is one row.
interface TextPolicy {
  readonly lines: boolean;
}

const LINES: TextPolicy = { lines: true };
const ONE_ROW: TextPolicy = { lines: false };

// Every mode's rules, in one entry each. The record type makes the compiler ask for an entry for a
// new mode, with both its key and its paste rules.
const MODES: Record<InputMode, ModePolicy> = {
  prompt: {
    key: (input, key) => routeTextKey(input, key, LINES),
    paste: (text) => insert(text, LINES),
  },
  approval: { key: routeApprovalKey, paste: () => [] },
  reason: {
    key: (input, key) => routeTextKey(input, key, ONE_ROW),
    paste: (text) => insert(text, ONE_ROW),
  },
};

// `input` and `key` are what Ink's useInput passes: the typed text, empty for a named key such as
// an arrow, and the flags that name the key.
export function routeKey(mode: InputMode, input: string, key: KeyPress): readonly KeyAction[] {
  // The cancel keys work the same in every mode, because a task can be running in any of them.
  // Ctrl+C reaches the policy because mountTui turns off Ink's exitOnCtrlC.
  if (key.escape || (key.ctrl && input === "c")) {
    return [{ kind: "cancel" }];
  }
  if (KITTY_QUERY_ANSWER.test(input)) {
    return [];
  }
  return MODES[mode].key(input, key);
}

// Text the terminal marked as pasted. Ink delivers it in one piece through usePaste, however many
// reads it took, so a line break inside it never acts as Enter.
export function routePaste(mode: InputMode, text: string): readonly KeyAction[] {
  return MODES[mode].paste(text);
}

// The keys of the text being typed: Enter submits it, the new line keys start a line in text that
// holds lines, and scroll keys go to the viewport and editing keys to the text, so neither reaches
// the other.
function routeTextKey(input: string, key: KeyPress, policy: TextPolicy): readonly KeyAction[] {
  if (isNewLineKey(input, key)) {
    return policy.lines ? [NEW_LINE] : [];
  }
  if (key.return) {
    return [SUBMIT];
  }
  const editing = routeEditingKey(key, policy);
  if (editing !== undefined) {
    return editing;
  }
  const scroll = routeScroll(key);
  if (scroll !== undefined) {
    return [scroll];
  }
  if (key.ctrl || key.meta) {
    return [];
  }
  // Ink leaves a carriage return inside a chunk of text, and the chunk alone cannot tell keys typed
  // ahead while the TUI was busy from lines pasted without bracketed paste. So a chunk submits at
  // most once, when it ends in Enter, and a line break inside it is a line break in the text: a
  // paste never starts several Coding Tasks. Typing ahead pays for it. Two tasks typed with Enter
  // before Ink reads them go as one, and an Enter with more typing after it submits nothing.
  const enter = /\r\n?$/.exec(input);
  if (enter === null) {
    return insert(input, policy);
  }
  return [...insert(input.slice(0, enter.index), policy), SUBMIT];
}

// Shift+Enter, which Ink tells from Enter only when the terminal speaks the kitty keyboard
// protocol; Alt+Enter; and Ctrl+J, a line feed on its own in every terminal and Ctrl with J under
// the kitty protocol.
function isNewLineKey(input: string, key: KeyPress): boolean {
  if (key.return) {
    return key.shift === true || key.meta === true;
  }
  return input === "\n" || (key.ctrl === true && input === "j");
}

// A decision takes one key on its own. Enter decides nothing and neither does a chunk of several
// characters. That a key comes after a pause, not while the person is still typing, is mountTui's
// to check, because it depends on when the keys came.
function routeApprovalKey(input: string, key: KeyPress): readonly KeyAction[] {
  const scroll = routeScroll(key);
  if (scroll !== undefined) {
    return [scroll];
  }
  if (key.ctrl || key.meta) {
    return [];
  }
  switch (input.toLowerCase()) {
    case ALLOW_KEY:
      return [{ kind: "allow" }];
    case DENY_KEY:
      return [{ kind: "deny" }];
    default:
      return [];
  }
}

function routeEditingKey(key: KeyPress, policy: TextPolicy): readonly KeyAction[] | undefined {
  if (key.backspace) {
    return [{ kind: "backspace" }];
  }
  if (key.delete) {
    return [{ kind: "delete" }];
  }
  if (key.leftArrow) {
    return [{ kind: "move", to: "left" }];
  }
  if (key.rightArrow) {
    return [{ kind: "move", to: "right" }];
  }
  // Up and Down move between rows; one row has none to move to.
  if (key.upArrow) {
    return policy.lines ? [{ kind: "move", to: "up" }] : [];
  }
  if (key.downArrow) {
    return policy.lines ? [{ kind: "move", to: "down" }] : [];
  }
  if (key.home) {
    return [{ kind: "move", to: "home" }];
  }
  if (key.end) {
    return [{ kind: "move", to: "end" }];
  }
  return undefined;
}

function routeScroll(key: KeyPress): KeyAction | undefined {
  if (key.pageUp) {
    return { kind: "scroll", direction: -1 };
  }
  if (key.pageDown) {
    return { kind: "scroll", direction: 1 };
  }
  return undefined;
}

// Typed and pasted text alike can carry line breaks and tabs. Text that holds lines keeps the line
// breaks, in one form; one row turns them into spaces. Tabs become spaces, and other control
// characters are dropped.
function insert(input: string, policy: TextPolicy): readonly KeyAction[] {
  const text = input
    .replace(/\r\n?|\n/g, policy.lines ? "\n" : " ")
    .replace(/\t/g, " ")
    .replace(/[^\P{Cc}\n]/gu, "");
  return text === "" ? [] : [{ kind: "insert", text }];
}
