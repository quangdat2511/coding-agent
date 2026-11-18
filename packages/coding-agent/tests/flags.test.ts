import { describe, expect, it } from "bun:test";
import { fieldsOf, readFlags } from "../src/flags.ts";

const flagOf = { provider: "--provider", repoRoot: "--repo-root" } as const;
const fieldOf = fieldsOf(flagOf);

describe("fieldsOf", () => {
  it("maps each flag to the field it sets", () => {
    expect([...fieldOf]).toEqual([
      ["--provider", "provider"],
      ["--repo-root", "repoRoot"],
    ]);
  });
});

describe("readFlags", () => {
  it("reads both spellings of a value into the field of its flag", () => {
    expect(readFlags(["--provider", "google", "--repo-root=/r"], fieldOf)).toEqual({
      raw: { provider: "google", repoRoot: "/r" },
    });
  });

  it.each([
    { tokens: ["--nope"], flag: "--nope", message: 'unknown flag "--nope"' },
    { tokens: ["word"], flag: undefined, message: 'unexpected argument "word"' },
    {
      tokens: ["--provider", "a", "--provider", "b"],
      flag: "--provider",
      message: "--provider was given more than once",
    },
    { tokens: ["--provider"], flag: "--provider", message: "--provider requires a value" },
    { tokens: ["--provider="], flag: "--provider", message: "--provider requires a value" },
  ])("refuses $tokens", ({ tokens, flag, message }) => {
    expect(readFlags(tokens, fieldOf)).toEqual({
      problem: flag === undefined ? { message } : { flag, message },
    });
  });
});
