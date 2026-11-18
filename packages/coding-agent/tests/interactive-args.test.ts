import { describe, expect, it } from "bun:test";
import { INTERACTIVE_USAGE, parseInteractiveArgs } from "../src/interactive-args.ts";

const cwd = "/workspace";

const valid = ["--provider", "anthropic", "--model", "claude-haiku-4-5"];

const usageError = (flag: string | undefined, message: string) => ({
  ok: false as const,
  code: "USAGE_ERROR" as const,
  ...(flag === undefined ? {} : { flag }),
  message,
});

describe("parsing the interactive options", () => {
  it("returns the provider and model, defaulting the repository root to the working directory", () => {
    expect(parseInteractiveArgs(valid, cwd)).toEqual({
      ok: true,
      args: { provider: "anthropic", model: "claude-haiku-4-5", repoRoot: cwd },
    });
  });

  it("lets --repo-root override the default, in either spelling", () => {
    for (const argv of [
      [...valid, "--repo-root", "/elsewhere"],
      [...valid, "--repo-root=/elsewhere"],
    ]) {
      expect(parseInteractiveArgs(argv, cwd)).toMatchObject({
        ok: true,
        args: { repoRoot: "/elsewhere" },
      });
    }
  });

  it("accepts the flags in any order", () => {
    expect(parseInteractiveArgs(["--model=m", "--provider=google"], cwd)).toMatchObject({
      ok: true,
      args: { provider: "google", model: "m" },
    });
  });
});

describe("refusing a bad interactive invocation", () => {
  it.each([
    { name: "no arguments", argv: [], flag: "--provider", message: "--provider is required" },
    {
      name: "a missing --model",
      argv: ["--provider", "anthropic"],
      flag: "--model",
      message: "--model is required",
    },
    {
      name: "an unknown provider",
      argv: ["--provider", "mistral", "--model", "m"],
      flag: "--provider",
      message:
        '--provider must be one of anthropic, openrouter, openai, google, xai, opencode, not "mistral"',
    },
    {
      name: "a flag without a value",
      argv: ["--provider", "anthropic", "--model"],
      flag: "--model",
      message: "--model requires a value",
    },
    {
      name: "a repeated flag",
      argv: [...valid, "--model", "other"],
      flag: "--model",
      message: "--model was given more than once",
    },
    {
      name: "a bare positional argument",
      argv: [...valid, "task.md"],
      message: 'unexpected argument "task.md"',
    },
    ...["--task-file", "--output-dir", "--profile", "--approval-policy"].map((flag) => ({
      name: `${flag}, which belongs to coding-agent run`,
      argv: [...valid, flag, "x"],
      flag,
      message: `unknown flag "${flag}"`,
    })),
  ] satisfies { name: string; argv: string[]; flag?: string; message: string }[])(
    "exits with a usage error on $name",
    ({ argv, flag, message }) => {
      expect(parseInteractiveArgs(argv, cwd)).toStrictEqual(usageError(flag, message));
    },
  );
});

describe("the interactive usage text", () => {
  it("documents every flag it accepts and none that only run accepts", () => {
    for (const flag of ["--provider", "--model", "--repo-root"]) {
      expect(INTERACTIVE_USAGE).toContain(flag);
    }
    for (const flag of ["--task-file", "--output-dir", "--profile", "--approval-policy"]) {
      expect(INTERACTIVE_USAGE).not.toContain(flag);
    }
  });
});
