import { describe, expect, it } from "bun:test";
import { PROVIDER_CREDENTIAL_ENV_VARS, type ProviderCredentialEnvVar } from "../src/credentials.ts";

describe("PROVIDER_CREDENTIAL_ENV_VARS", () => {
  it("contains exactly the 7 MVP provider credential variable names", () => {
    expect([...PROVIDER_CREDENTIAL_ENV_VARS].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "OPENAI_API_KEY",
      "OPENCODE_API_KEY",
      "OPENROUTER_API_KEY",
      "XAI_API_KEY",
    ]);
  });

  it("contains OPENCODE_API_KEY (ADR 0007 promotes opencode to the sixth provider)", () => {
    expect(PROVIDER_CREDENTIAL_ENV_VARS).toContain("OPENCODE_API_KEY");
  });

  it("does not contain OPENCODE_SESSION_ID (a session id is not a credential)", () => {
    expect(PROVIDER_CREDENTIAL_ENV_VARS).not.toContain("OPENCODE_SESSION_ID");
  });

  it("is a readonly tuple (Object.isFrozen on the array)", () => {
    // `as const` makes it readonly at compile time; at runtime the array
    // itself is frozen by Object.freeze in the module.
    expect(Object.isFrozen(PROVIDER_CREDENTIAL_ENV_VARS)).toBe(true);
  });

  it("exports ProviderCredentialEnvVar type matching the tuple elements", () => {
    const validVar: ProviderCredentialEnvVar = "ANTHROPIC_API_KEY";
    expect(PROVIDER_CREDENTIAL_ENV_VARS).toContain(validVar);
  });
});
