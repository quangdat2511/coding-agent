import { afterEach, describe, expect, it } from "bun:test";
import { apiKeyFromEnv, readEnvCredential } from "../src/auth/helpers.ts";

describe("readEnvCredential", () => {
  it("returns the first variable that is set, with its value trimmed", () => {
    expect(
      readEnvCredential(["GOOGLE_API_KEY", "GEMINI_API_KEY"], {
        GOOGLE_API_KEY: " google-key\r\n",
        GEMINI_API_KEY: "gemini-key",
      }),
    ).toEqual({ variable: "GOOGLE_API_KEY", value: "google-key" });
  });

  it("skips a blank variable and falls back to the next one", () => {
    expect(
      readEnvCredential(["GOOGLE_API_KEY", "GEMINI_API_KEY"], {
        GOOGLE_API_KEY: " \t",
        GEMINI_API_KEY: "gemini-key",
      }),
    ).toEqual({ variable: "GEMINI_API_KEY", value: "gemini-key" });
  });

  it("finds nothing when every variable is unset or blank", () => {
    expect(readEnvCredential(["GOOGLE_API_KEY", "GEMINI_API_KEY"], { GOOGLE_API_KEY: "" })).toBe(
      undefined,
    );
  });
});

describe("apiKeyFromEnv", () => {
  const original = {
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("resolves the key readEnvCredential finds in the process environment", async () => {
    process.env.GOOGLE_API_KEY = " ";
    process.env.GEMINI_API_KEY = "gemini-key\n";
    const source = apiKeyFromEnv("Google API key", ["GOOGLE_API_KEY", "GEMINI_API_KEY"]);
    expect(await source.resolve()).toBe("gemini-key");
  });
});
