import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";

// What the committed recording of the interactive path has to show (ADR 0006 §6 item 6): the
// output streaming, one Approval decided in the overlay, and one cancellation that settles the
// session with its workspace report, with no credential anywhere in the file. The recording is a
// terminal capture in the asciicast format of asciinema, version 2 or 3. Both put one JSON header
// on the first line and one `[time, code, data]` event on each line after it.
//
// The checks read the strings the TUI draws (packages/tui/src/rows.ts and frame.tsx), so a change
// to those strings makes a recording stale, and this file is the place that says so.

// The header of a recording may name only these environment variables, which asciinema records by
// default. Anything else could carry a credential.
const RECORDED_ENVIRONMENT = new Set(["SHELL", "TERM"]);

const MIN_COLUMNS = 80;
const MIN_ROWS = 24;

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
  { name: "a bearer token", pattern: /\bBearer\s+[0-9A-Za-z._~+/-]{20,}/i },
  { name: "an API key header", pattern: /x-goog-api-key\s*:\s*\S{8,}/i },
  ...PROVIDER_CREDENTIAL_ENV_VARS.map((variable) => ({
    name: `a value for ${variable}`,
    pattern: new RegExp(`${variable}\\s*[=:]\\s*(?!\\[redacted\\])\\S{8,}`),
  })),
];

// Transcript lines that mean the run exposed a defect. The ticket allows a defect to be fixed or
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

  for (const { name, pattern } of CREDENTIAL_SHAPES) {
    if (pattern.test(recording) || pattern.test(visibleText(output))) {
      problems.push(`the recording holds ${name}`);
    }
  }

  const screen = visibleText(output);
  for (const sign of DEFECT_SIGNS) {
    if (screen.includes(sign)) problems.push(`the transcript shows "${sign}"`);
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
  step(/assistant \[streaming\]/, "the assistant streaming");
  step(/\by allow\b/, "the Approval overlay with its allow key");
  step(/\[(?:executing|succeeded)\]/, "the allowed Tool Call running");
  step(/cancellation requested/, "the cancellation being requested");
  step(/session \[cancelled\]/, "the cancelled session settling");
  // The demo allows a mutating Tool Call before it cancels, so the session must say so.
  step(
    /workspace changed, partial changes possible/,
    "the cancelled session reporting that the workspace changed and partial changes are possible",
  );

  return problems;
}
