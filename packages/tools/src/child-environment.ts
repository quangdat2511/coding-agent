export type ChildEnvironment = Readonly<Record<string, string | undefined>>;

/** Internal to tools: keep credential and execution-mode matching on the same platform rule. */
export function environmentKeyOf(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

export type CreateChildEnvironmentResult =
  | {
      readonly ok: true;
      readonly build: (parent: ChildEnvironment) => Record<string, string | undefined>;
    }
  | {
      readonly ok: false;
      readonly code: "INVALID_CONFIGURATION";
      readonly field: "credentialEnvVars";
      readonly message: string;
    };

export function createChildEnvironmentBuilder(
  credentialEnvVars: readonly string[],
  platform: NodeJS.Platform = process.platform,
): CreateChildEnvironmentResult {
  if (
    !Array.isArray(credentialEnvVars) ||
    credentialEnvVars.length === 0 ||
    [...credentialEnvVars].some(
      (name) => typeof name !== "string" || name.length === 0 || /[=\0]/.test(name),
    )
  ) {
    return {
      ok: false,
      code: "INVALID_CONFIGURATION",
      field: "credentialEnvVars",
      message: "credentialEnvVars must be a non-empty array of valid environment variable names",
    };
  }
  const keyOf = (name: string): string => environmentKeyOf(name, platform);
  const names = new Set(credentialEnvVars.map(keyOf));
  return {
    ok: true,
    build: (parent) =>
      Object.fromEntries(Object.entries(parent).filter(([key]) => !names.has(keyOf(key)))),
  };
}
