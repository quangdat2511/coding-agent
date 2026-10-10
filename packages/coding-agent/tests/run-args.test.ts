import { describe, expect, it } from "bun:test";
import * as surface from "../src/index.ts";
import { type Profile, type Provider, parseRunArgs, type RunArgs, USAGE } from "../src/run-args.ts";

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

/** The documented invocation with one required flag and its value removed. */
const without = (flag: string): string[] => [
  "run",
  ...required.filter(([name]) => name !== flag).flat(),
];

const usageError = (flag: string | undefined) => ({
  ok: false as const,
  code: "USAGE_ERROR" as const,
  ...(flag === undefined ? {} : { flag }),
  message: expect.stringContaining(flag ?? ""),
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

  it("accepts a value that begins with two dashes through the = form", () => {
    expect(parseRunArgs([...without("--model"), "--model=--odd"], cwd)).toMatchObject({
      ok: true,
      args: { model: "--odd" },
    });
  });

  it.each(["anthropic", "openrouter", "openai", "google", "xai"])(
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
    { name: "no arguments at all", argv: [], flag: undefined },
    { name: "an unknown command", argv: ["serve", ...required.flat()], flag: undefined },
    {
      name: "a bare positional argument",
      argv: ["run", "task.md", ...required.flat()],
      flag: undefined,
    },
    { name: "an unknown flag", argv: [...valid, "--verbose"], flag: "--verbose" },
    { name: "an unknown flag in the = form", argv: [...valid, "--verbose=1"], flag: "--verbose" },
    {
      name: "a flag whose case does not match",
      argv: [...without("--provider"), "--Provider", "anthropic"],
      flag: "--Provider",
    },
    { name: "--help, which ADR 0005 §3 does not list", argv: ["run", "--help"], flag: "--help" },
    {
      name: "an unknown provider",
      argv: [...without("--provider"), "--provider", "mistral"],
      flag: "--provider",
    },
    { name: "an unknown profile", argv: [...valid, "--profile", "fast"], flag: "--profile" },
    {
      name: "an approval policy of ask",
      argv: [...without("--approval-policy"), "--approval-policy", "ask"],
      flag: "--approval-policy",
    },
    {
      name: "an approval policy that is merely misspelt",
      argv: [...without("--approval-policy"), "--approval-policy", "auto_approve"],
      flag: "--approval-policy",
    },
    {
      name: "a flag left without a value at the end",
      argv: [...without("--provider"), "--provider"],
      flag: "--provider",
    },
    {
      name: "a flag followed by the next flag",
      argv: ["run", "--provider", "--model", "m"],
      flag: "--provider",
    },
    {
      name: "a flag given an empty value",
      argv: [...without("--provider"), "--provider="],
      flag: "--provider",
    },
    { name: "a flag given twice", argv: [...valid, "--model", "other"], flag: "--model" },
  ] satisfies { name: string; argv: string[]; flag: string | undefined }[])(
    "exits with a usage error on $name",
    ({ argv, flag }) => {
      expect(parseRunArgs(argv, cwd)).toEqual(usageError(flag));
    },
  );

  it.each(required.map(([flag]) => flag))("exits with a usage error when %s is missing", (flag) => {
    expect(parseRunArgs(without(flag), cwd)).toEqual(usageError(flag));
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

  it("offers five providers and two profiles", () => {
    const providers = {
      anthropic: true,
      openrouter: true,
      openai: true,
      google: true,
      xai: true,
    } satisfies Record<Provider, true>;
    const profiles = { default: true, terminalbench: true } satisfies Record<Profile, true>;
    expect(Object.keys(providers)).toHaveLength(5);
    expect(Object.keys(profiles)).toHaveLength(2);
  });

  it("documents every flag it accepts, so the usage text cannot drift", () => {
    for (const flag of flags) expect(USAGE).toContain(flag);
  });
});

describe("public runtime surface", () => {
  it("exports nothing yet, because ADR 0004 §6 pins the surface to the three entry points", () => {
    expect(Object.keys(surface)).toEqual([]);
  });
});
