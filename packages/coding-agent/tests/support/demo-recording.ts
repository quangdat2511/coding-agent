import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";

// What the committed recording of the interactive path has to show (ADR 0006 §6 item 6): the
// output streaming, one Approval decided in the overlay, and one Cancellation that settles the
// Agent Run with its workspace report, with no credential anywhere in the file. The recording is a
// terminal capture in the asciicast format of asciinema, version 2 or 3. Both put one JSON header
// on the first line and one `[time, code, data]` event on each line after it.
//
// The checks read the strings the TUI draws (packages/tui/src/rows.ts and frame.tsx), so a change
// to those strings makes a recording stale, and this file is the place that says so.

// The header of a recording may name only these environment variables, which asciinema records by
// default. Anything else could carry a credential.
const RECORDED_ENVIRONMENT = new Set(["SHELL", "TERM"]);

// The size that demo/README.md and demo/record.sh ask for, so that CI refuses what the docs forbid.
const MIN_COLUMNS = 100;
const MIN_ROWS = 32;

// Escape sequences that move the cursor or style text, which the screen redraws are made of: CSI,
// OSC (ended by BEL or ST), and the two-character forms such as character set selection.
const ESCAPE_SEQUENCES = new RegExp(
  [
    String.raw`\u001b\[[0-?]*[ -/]*[@-~]`,
    String.raw`\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)`,
    String.raw`\u001b[()][0-9A-Za-z]`,
    String.raw`\u001b[=>78]`,
  ].join("|"),
  "g",
);

// A credential is a known provider key shape, or a provider's variable name given a value. The
// recording script also searches for the exact value of the key that was in use; this cannot.
const CREDENTIAL_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "a Google API key", pattern: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: "an `sk-` API key", pattern: /\bsk-[0-9A-Za-z_-]{20,}/ },
  { name: "an `xai-` API key", pattern: /\bxai-[0-9A-Za-z_-]{20,}/ },
  { name: "a bearer token", pattern: /\bBearer\s+[0-9A-Za-z._~+/-]{20,}/i },
  { name: "an API key header", pattern: /\bx-(?:goog-)?api-key\s*:\s*\S{8,}/i },
  { name: "an Authorization header", pattern: /\bAuthorization\s*:\s*(?!Bearer\b)\S{16,}/i },
  ...PROVIDER_CREDENTIAL_ENV_VARS.map((variable) => ({
    name: `a value for ${variable}`,
    pattern: new RegExp(`${variable}\\s*[=:]\\s*(?!\\[redacted\\])\\S{8,}`),
  })),
];

// Session view lines that mean the run exposed a defect. The ticket allows a defect to be fixed or
// filed, never to be left in the committed recording unremarked.
const DEFECT_SIGNS = [
  "Internal error:",
  "could not be shown",
  "The decision was not applied",
  "The event stream failed",
  "Cancel was not dispatched",
  "CANCELLATION_TIMEOUT",
];

interface Header {
  readonly version?: number;
  readonly width?: number;
  readonly height?: number;
  readonly term?: { readonly cols?: number; readonly rows?: number };
  readonly env?: Readonly<Record<string, unknown>>;
}

// The text the terminal would show, in the order it was written: the output events with their
// escape sequences and carriage returns removed.
export function visibleText(output: string): string {
  return output.replace(ESCAPE_SEQUENCES, "").replaceAll("\r", "");
}

// Every problem that makes `recording` unfit to commit, one message each. An empty list means it
// is fit.
export function checkRecording(recording: string): string[] {
  const lines = recording.split("\n").filter((line) => line.trim() !== "");
  const [first, ...rest] = lines;
  if (first === undefined) return ["the recording is empty"];

  let header: Header;
  try {
    header = JSON.parse(first) as Header;
  } catch {
    return ["the first line is not a JSON header: this is not an asciicast file"];
  }
  const problems: string[] = [];

  if (header.version !== 2 && header.version !== 3) {
    problems.push(`asciicast version ${header.version} is not 2 or 3`);
  }
  const columns = header.width ?? header.term?.cols ?? 0;
  const rows = header.height ?? header.term?.rows ?? 0;
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    problems.push(
      `the terminal was ${columns}x${rows}; record at least ${MIN_COLUMNS}x${MIN_ROWS} so the ` +
        "overlay and the outcome fit",
    );
  }
  for (const name of Object.keys(header.env ?? {})) {
    if (!RECORDED_ENVIRONMENT.has(name)) {
      problems.push(`the header records the environment variable ${name}`);
    }
  }

  let output = "";
  for (const [index, line] of rest.entries()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      problems.push(`event ${index + 1} is not JSON`);
      break;
    }
    if (!Array.isArray(event) || typeof event[1] !== "string" || typeof event[2] !== "string") {
      problems.push(`event ${index + 1} is not a [time, code, data] triple`);
      break;
    }
    // Keystrokes are recorded only on request, and a person could have typed a key into the
    // Prompt or the shell.
    if (event[1] === "i") {
      problems.push("the recording holds keyboard input; record without --stdin");
      break;
    }
    if (event[1] === "o") output += event[2];
  }

  const screen = visibleText(output);
  // The TUI breaks a long line at the width of the terminal, which can cut a key in two, so the
  // shapes are also tried on the text with its line breaks taken out. That glues the last word of
  // the row before onto the key, so the word boundaries of the shapes are dropped for that try.
  const unwrapped = screen.replaceAll("\n", "");
  for (const { name, pattern } of CREDENTIAL_SHAPES) {
    const unbounded = new RegExp(pattern.source.replaceAll(String.raw`\b`, ""), pattern.flags);
    if (pattern.test(recording) || pattern.test(screen) || unbounded.test(unwrapped)) {
      problems.push(`the recording holds ${name}`);
    }
  }

  for (const sign of DEFECT_SIGNS) {
    if (screen.includes(sign)) problems.push(`the Session view shows "${sign}"`);
  }
  // The demo allows one Approval and cancels at the next. A denial means the person pressed the
  // wrong key, and the run is not the one the demo script describes.
  if (/\[denied\b|APPROVAL_DENIED/.test(screen)) {
    problems.push("the Session view shows a denied Approval; the demo allows one and cancels");
  }

  // Each step has to come after the one before it, so a recording that only cuts together the
  // right words in the wrong order does not pass.
  let position = 0;
  const step = (pattern: RegExp, shows: string): void => {
    const found = pattern.exec(screen.slice(position));
    if (found === null) {
      problems.push(`the recording does not show ${shows}, after the step before it`);
      return;
    }
    position += found.index + found[0].length;
  };
  // `assistant [streaming]` is the row the TUI draws for the model's answer while it arrives.
  step(/assistant \[streaming\]/, "the model's answer streaming");
  step(/\by allow\b/, "the Approval overlay with its allow key");
  // Any Tool Call after the overlay: a wrapped row could hide the tool's name, so it is not named.
  step(/\[(?:executing|succeeded)\]/, "a Tool Call running after the overlay");
  step(/cancellation requested/, "the Cancellation being requested");
  step(/^run \[cancelled\]/m, "the cancelled Agent Run settling");
  // The demo allows a mutating Tool Call before it cancels, so the Agent Run must say so.
  step(
    /workspace changed, partial changes possible/,
    "the cancelled Agent Run reporting that the workspace changed and partial changes are possible",
  );

  return problems;
}
