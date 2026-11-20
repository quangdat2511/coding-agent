import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { checkRecording, visibleText } from "./support/demo-recording.ts";

// The committed recording of the interactive path is the demo of ADR 0006 §6 item 6. "The demo
// works" is not checkable, so this test checks the file: it must show what CDA-87 asks for, and
// hold no credential. The first describe tests the check itself against hand-made recordings.

const RECORDING = join(import.meta.dir, "..", "demo", "interactive-path.cast");

const header = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 2,
    width: 100,
    height: 32,
    timestamp: 1_790_000_000,
    env: { SHELL: "/bin/bash", TERM: "xterm-256color" },
    ...extra,
  });

// One output event per string, a tenth of a second apart.
const recordingOf = (outputs: readonly string[], head = header()) =>
  [head, ...outputs.map((data, index) => JSON.stringify([(index + 1) / 10, "o", data]))].join("\n");

// What the demo shows, in order, as the TUI draws it: styled, and with the cursor moved between
// frames.
const GOOD_RUN = [
  "\u001b[?1049h\u001b[2J> Add a failing test, then make it pass.\r\n",
  "\u001b[1massistant [streaming]\u001b[22m\r\n",
  "bash bun test [awaiting_approval]\r\n",
  "\u001b[7mEsc/Ctrl+C cancel · y allow · n deny · PgUp/PgDn scroll\u001b[27m\r\n",
  "\u001b[2K\u001b[1Abash bun test [executing]\r\n",
  "write src/slugify.test.ts [awaiting_approval]\r\n",
  "\u001b[1;32mnotice\u001b[0m cancellation requested\r\n",
  "session [cancelled]\r\n  workspace changed, partial changes possible\r\n",
];

describe("checking a recording of the interactive path", () => {
  it("accepts a run with an allowed Approval and a Cancellation that settles", () => {
    expect(checkRecording(recordingOf(GOOD_RUN))).toEqual([]);
  });

  it("accepts the version 3 header, which names the terminal size differently", () => {
    const v3 = JSON.stringify({
      version: 3,
      term: { cols: 100, rows: 32 },
      env: { SHELL: "/bin/bash", TERM: "xterm" },
    });
    expect(checkRecording(recordingOf(GOOD_RUN, v3))).toEqual([]);
  });

  it("reads the text through the escape sequences of a redraw", () => {
    expect(visibleText("\u001b[2K\u001b[1Aab\u001b[31mc\u001b[0m\u001b]0;title\u0007d\r\n")).toBe(
      "abcd\n",
    );
  });

  it.each([
    ["the answer streaming", "assistant [streaming]", /answer streaming/],
    ["the overlay", "y allow", /Approval overlay/],
    ["a Tool Call after the overlay", "[executing]", /Tool Call running/],
    ["the cancellation request", "cancellation requested", /Cancellation being requested/],
    ["the cancelled session", "session [cancelled]", /cancelled session settling/],
    ["the workspace report", "workspace changed, partial changes possible", /workspace changed/],
  ])("rejects a run without %s", (_name, text, problem) => {
    const run = GOOD_RUN.map((output) => output.replace(text, "…"));
    const problems = checkRecording(recordingOf(run));
    expect(problems.some((message) => problem.test(message))).toBe(true);
  });

  it("rejects a run whose steps come in the wrong order", () => {
    const problems = checkRecording(recordingOf([...GOOD_RUN].reverse()));
    expect(problems.length).toBeGreaterThan(0);
  });

  it("rejects a cancellation that timed out instead of settling", () => {
    const run = GOOD_RUN.map((output) =>
      output.replace("session [cancelled]", "session [failed, CANCELLATION_TIMEOUT]"),
    );
    const problems = checkRecording(recordingOf(run));
    expect(problems).toContain('the transcript shows "CANCELLATION_TIMEOUT"');
  });

  it("rejects a transcript that shows a defect of the run", () => {
    const run = [...GOOD_RUN, "notice Internal error: boom\r\n"];
    expect(checkRecording(recordingOf(run))).toContain('the transcript shows "Internal error:"');
  });

  it("rejects keyboard input", () => {
    const withInput = `${recordingOf(GOOD_RUN)}\n${JSON.stringify([2, "i", "y"])}`;
    expect(checkRecording(withInput)).toContain(
      "the recording holds keyboard input; record without --stdin",
    );
  });

  it("rejects a header that records more than the shell and the terminal", () => {
    const head = header({ env: { SHELL: "/bin/bash", TERM: "xterm", GOOGLE_API_KEY: "x" } });
    expect(checkRecording(recordingOf(GOOD_RUN, head))).toContain(
      "the header records the environment variable GOOGLE_API_KEY",
    );
  });

  it("rejects a terminal smaller than the 100x32 the demo script asks for", () => {
    const problems = checkRecording(recordingOf(GOOD_RUN, header({ width: 80, height: 24 })));
    expect(problems.some((message) => message.startsWith("the terminal was 80x24"))).toBe(true);
    expect(checkRecording(recordingOf(GOOD_RUN, header({ width: 100, height: 32 })))).toEqual([]);
  });

  it("rejects a run in which an Approval was denied", () => {
    const run = [...GOOD_RUN, "bash git log [denied, APPROVAL_DENIED]\r\n"];
    expect(checkRecording(recordingOf(run))).toContain(
      "the transcript shows a denied Approval; the demo allows one and cancels",
    );
  });

  it.each([
    ["a Google API key", `AIza${"a".repeat(35)}`],
    ["an `sk-` API key", `sk-${"a".repeat(30)}`],
    ["an `xai-` API key", `xai-${"a".repeat(30)}`],
    ["a value for OPENCODE_API_KEY", "OPENCODE_API_KEY=abcdefgh1234"],
    ["a bearer token", `Authorization: Bearer ${"a".repeat(30)}`],
    ["a value for GOOGLE_API_KEY", "GOOGLE_API_KEY=abcdefgh1234"],
  ])("rejects a recording that holds %s", (name, secret) => {
    const run = [...GOOD_RUN, `${secret}\r\n`];
    expect(checkRecording(recordingOf(run))).toContain(`the recording holds ${name}`);
  });

  it("accepts the redacted form of a credential", () => {
    const run = [...GOOD_RUN, "GOOGLE_API_KEY=[redacted]\r\n"];
    expect(checkRecording(recordingOf(run))).toEqual([]);
  });

  it("rejects a file that is not an asciicast", () => {
    expect(checkRecording("")).toEqual(["the recording is empty"]);
    expect(checkRecording("not json")).toEqual([
      "the first line is not a JSON header: this is not an asciicast file",
    ]);
  });
});

describe("the committed recording of the interactive path", () => {
  it("shows streaming, an Approval decided in the overlay and a Cancellation that settles", async () => {
    const file = Bun.file(RECORDING);
    if (!(await file.exists())) {
      throw new Error(
        "packages/coding-agent/demo/interactive-path.cast is missing: record the demo by " +
          "following packages/coding-agent/demo/README.md (CDA-87)",
      );
    }
    expect(checkRecording(await file.text())).toEqual([]);
  });
});
