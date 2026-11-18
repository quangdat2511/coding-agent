import { describe, expect, it } from "bun:test";
import { COMMAND_LINE_USAGE, parseCommandLine } from "../src/command-line.ts";
import { INTERACTIVE_USAGE } from "../src/interactive-args.ts";
import { USAGE } from "../src/run-args.ts";

const cwd = "/workspace";

const run = [
  "run",
  ...["--task-file", "/tmp/task.md"],
  ...["--provider", "anthropic"],
  ...["--model", "claude-haiku-4-5"],
  ...["--approval-policy", "auto-approve"],
  ...["--output-dir", "/tmp/out"],
];

describe("choosing between the two entry points", () => {
  it("parses a line that starts with run as the headless command", () => {
    expect(parseCommandLine(run, cwd)).toMatchObject({
      ok: true,
      command: "run",
      args: { taskFile: "/tmp/task.md", approvalPolicy: "auto-approve", repoRoot: cwd },
    });
  });

  it("parses a line of flags as the interactive command", () => {
    expect(parseCommandLine(["--provider", "google", "--model", "gemini-2.5-flash"], cwd)).toEqual({
      ok: true,
      command: "interactive",
      args: { provider: "google", model: "gemini-2.5-flash", repoRoot: cwd },
    });
  });

  it("treats no arguments as an interactive line that lacks --provider", () => {
    expect(parseCommandLine([], cwd)).toStrictEqual({
      ok: false,
      code: "USAGE_ERROR",
      flag: "--provider",
      message: "--provider is required",
    });
  });

  it("refuses an unknown command by name", () => {
    expect(parseCommandLine(["serve"], cwd)).toMatchObject({
      ok: false,
      message: 'unknown command "serve"',
    });
  });

  it("keeps every run error as parseRunArgs reports it", () => {
    expect(
      parseCommandLine([...run.slice(0, 7), "--approval-policy", "ask", ...run.slice(9)], cwd),
    ).toMatchObject({
      ok: false,
      flag: "--approval-policy",
      message: '--approval-policy must be "auto-approve", not "ask"',
    });
  });

  it("refuses the run-only flags on an interactive line", () => {
    expect(
      parseCommandLine(["--provider", "google", "--model", "m", "--approval-policy", "ask"], cwd),
    ).toMatchObject({ ok: false, message: 'unknown flag "--approval-policy"' });
  });
});

describe("the combined usage text", () => {
  it("shows both entry points", () => {
    expect(COMMAND_LINE_USAGE).toContain(INTERACTIVE_USAGE);
    expect(COMMAND_LINE_USAGE).toContain(USAGE);
    expect(COMMAND_LINE_USAGE).toContain("usage: coding-agent run");
  });
});
