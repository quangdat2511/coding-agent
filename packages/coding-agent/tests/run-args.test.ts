import { describe, expect, it } from "bun:test";
import * as surface from "../src/index.ts";
import { parseRunArgs, type RunArgs, USAGE } from "../src/run-args.ts";

const cwd = "/workspace";

const flags = [
  "--task-file",
  "--provider",
  "--model",
  "--approval-policy",
  "--output-dir",
  "--profile",
  "--repo-root",
] as const;

const required = [
  ["--task-file", "/tmp/task.md"],
  ["--provider", "anthropic"],
  ["--model", "claude-sonnet-4"],
  ["--approval-policy", "auto-approve"],
  ["--output-dir", "/tmp/out"],
] as const;

const valid = ["run", ...required.flat()];

const without = (flag: string): string[] => [
  "run",
  ...required.filter(([name]) => name !== flag).flat(),
];

const usageError = (flag: string | undefined, message: string) => ({
  ok: false as const,
  code: "USAGE_ERROR" as const,
  ...(flag === undefined ? {} : { flag }),
  message,
});

describe("parsing a documented invocation", () => {
  it("returns every field, defaulting the profile and the repository root", () => {
    expect(parseRunArgs(valid, cwd)).toEqual({
      ok: true,
      args: {
        taskFile: "/tmp/task.md",
        provider: "anthropic",
        model: "claude-sonnet-4",
        approvalPolicy: "auto-approve",
        outputDir: "/tmp/out",
        profile: "default",
        repoRoot: cwd,
      },
    });
  });

  it("lets the optional flags override both defaults", () => {
    const parsed = parseRunArgs(
      [...valid, "--profile", "terminalbench", "--repo-root", "/elsewhere"],
      cwd,
    );
    expect(parsed).toMatchObject({
      ok: true,
      args: { profile: "terminalbench", repoRoot: "/elsewhere" },
    });
  });

  it("reads --flag=value exactly like --flag value", () => {
    const joined = ["run", ...required.map(([flag, value]) => `${flag}=${value}`)];
    expect(parseRunArgs(joined, cwd)).toEqual(parseRunArgs(valid, cwd));
  });

  it("carries a relative repository root verbatim, because CDA-59 resolves paths", () => {
    expect(parseRunArgs([...valid, "--repo-root", "./nested"], cwd)).toMatchObject({
      ok: true,
      args: { repoRoot: "./nested" },
    });
  });

  it.each(["--odd", "-"])("accepts the dash-prefixed value %s through the = form", (model) => {
    expect(parseRunArgs([...without("--model"), `--model=${model}`], cwd)).toMatchObject({
      ok: true,
      args: { model },
    });
  });

  it.each(["anthropic", "openrouter", "openai", "google", "xai", "opencode"])(
    "accepts the provider %s",
    (provider) => {
      expect(parseRunArgs([...without("--provider"), "--provider", provider], cwd)).toMatchObject({
        ok: true,
        args: { provider },
      });
    },
  );
});

describe("refusing a bad invocation", () => {
  it.each([
    { name: "no arguments at all", argv: [], message: "a command is required" },
    {
      name: "an unknown command",
      argv: ["serve", ...required.flat()],
      message: 'unknown command "serve"',
    },
    {
      name: "a bare positional argument",
      argv: ["run", "task.md", ...required.flat()],
      message: 'unexpected argument "task.md"',
    },
    {
      name: "an unknown flag",
      argv: [...valid, "--verbose"],
      flag: "--verbose",
      message: 'unknown flag "--verbose"',
    },
    {
      name: "an unknown flag in the = form",
      argv: [...valid, "--verbose=1"],
      flag: "--verbose",
      message: 'unknown flag "--verbose"',
    },
    {
      name: "a flag whose case does not match",
      argv: [...without("--provider"), "--Provider", "anthropic"],
      flag: "--Provider",
      message: 'unknown flag "--Provider"',
    },
    {
      name: "--help, which ADR 0005 §3 does not list",
      argv: ["run", "--help"],
      flag: "--help",
      message: 'unknown flag "--help"',
    },
    {
      name: "an unknown provider",
      argv: [...without("--provider"), "--provider", "mistral"],
      flag: "--provider",
      message:
        '--provider must be one of anthropic, openrouter, openai, google, xai, opencode, not "mistral"',
    },
    {
      name: "an unknown profile",
      argv: [...valid, "--profile", "fast"],
      flag: "--profile",
      message: '--profile must be one of default, terminalbench, not "fast"',
    },
    {
      name: "an approval policy of ask",
      argv: [...without("--approval-policy"), "--approval-policy", "ask"],
      flag: "--approval-policy",
      message: '--approval-policy must be "auto-approve", not "ask"',
    },
    {
      name: "an approval policy that is merely misspelt",
      argv: [...without("--approval-policy"), "--approval-policy", "auto_approve"],
      flag: "--approval-policy",
      message: '--approval-policy must be "auto-approve", not "auto_approve"',
    },
    {
      name: "a flag left without a value at the end",
      argv: [...without("--provider"), "--provider"],
      flag: "--provider",
      message: "--provider requires a value",
    },
    {
      name: "a flag followed by the next flag",
      argv: ["run", "--provider", "--model", "m"],
      flag: "--provider",
      message: "--provider requires a value",
    },
    {
      name: "a flag followed by a single-dash token",
      argv: [...without("--model"), "--model", "-p", "anthropic"],
      flag: "--model",
      message: "--model requires a value",
    },
    {
      name: "a flag given an empty value",
      argv: [...without("--provider"), "--provider="],
      flag: "--provider",
      message: "--provider requires a value",
    },
    {
      name: "a flag given a blank value",
      argv: [...without("--model"), "--model", "  "],
      flag: "--model",
      message: "--model requires a value",
    },
    {
      name: "a flag given twice",
      argv: [...valid, "--model", "other"],
      flag: "--model",
      message: "--model was given more than once",
    },
  ] satisfies { name: string; argv: string[]; flag?: string; message: string }[])(
    "exits with a usage error on $name",
    ({ argv, flag, message }) => {
      expect(parseRunArgs(argv, cwd)).toStrictEqual(usageError(flag, message));
    },
  );

  it.each(required.map(([flag]) => flag))("exits with a usage error when %s is missing", (flag) => {
    expect(parseRunArgs(without(flag), cwd)).toStrictEqual(usageError(flag, `${flag} is required`));
  });
});

describe("the ADR 0005 §3 contract", () => {
  it("accepts exactly one approval policy (compile-time)", () => {
    const allowed: RunArgs["approvalPolicy"] = "auto-approve";
    // @ts-expect-error ADR 0005 §3 accepts only "auto-approve" on the headless path.
    const refused: RunArgs["approvalPolicy"] = "ask";
    expect(allowed).toBe("auto-approve");
    expect(String(refused)).toBe("ask");
  });

  it("documents every flag it accepts, so the usage text cannot drift", () => {
    for (const flag of flags) expect(USAGE).toContain(flag);
  });
});

describe("public runtime surface", () => {
  it("exports runHeadless and projectSessionEvent, two of the three entry points ADR 0004 §6 pins it to", () => {
    expect(Object.keys(surface)).toEqual(["projectSessionEvent", "runHeadless"]);
  });
});
