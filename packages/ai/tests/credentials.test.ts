import { describe, expect, it } from "bun:test";
import { PROVIDER_CREDENTIAL_ENV_VARS, type ProviderCredentialEnvVar } from "#src/credentials";

describe("PROVIDER_CREDENTIAL_ENV_VARS", () => {
  it("contains exactly the 6 MVP provider credential variable names", () => {
    expect([...PROVIDER_CREDENTIAL_ENV_VARS].sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "XAI_API_KEY",
    ]);
  });

  it("does not contain OPENCODE_API_KEY (opencode is not an MVP provider)", () => {
    expect(PROVIDER_CREDENTIAL_ENV_VARS).not.toContain("OPENCODE_API_KEY");
  });

  it("does not contain OPENCODE_SESSION_ID", () => {
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
