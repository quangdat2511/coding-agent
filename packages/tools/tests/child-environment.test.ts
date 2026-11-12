import { describe, expect, it } from "bun:test";
import { createChildEnvironmentBuilder } from "../src/index.ts";

describe("building a child environment", () => {
  it("removes exactly the configured names and preserves task variables and same-prefixed names", () => {
    const configured = createChildEnvironmentBuilder(["MODEL_API_KEY", "FALLBACK_API_KEY"]);
    if (!configured.ok) throw new Error(configured.message);

    const environment = configured.build({
      MODEL_API_KEY: "provider-secret",
      FALLBACK_API_KEY: "fallback-secret",
      MODEL_API_KEY_BACKUP: "task-backup",
      GH_TOKEN: "task-token",
      PATH: "/task/bin",
      EMPTY: "",
      UNSET: undefined,
    });

    expect(environment).toEqual({
      MODEL_API_KEY_BACKUP: "task-backup",
      GH_TOKEN: "task-token",
      PATH: "/task/bin",
      EMPTY: "",
      UNSET: undefined,
    });
  });

  it.each<{ name: string; names: unknown }>([
    { name: "a missing name set", names: undefined },
    { name: "a null name set", names: null },
    { name: "an empty name set", names: [] },
    { name: "a sparse name set", names: new Array(1) },
    { name: "an empty name", names: [""] },
    { name: "a string instead of a name set", names: "MODEL_API_KEY" },
    { name: "a non-string name", names: [42] },
    { name: "a name containing equals", names: ["MODEL=API_KEY"] },
    { name: "a name containing NUL", names: ["MODEL\0API_KEY"] },
  ])("rejects $name as a configuration error", ({ names }) => {
    expect(createChildEnvironmentBuilder(names as readonly string[])).toMatchObject({
      ok: false,
      code: "INVALID_CONFIGURATION",
      field: "credentialEnvVars",
    });
  });

  it.each(["win32", "linux", "darwin"] as const)(
    "matches credential names according to %s environment rules",
    (platform) => {
      const configured = createChildEnvironmentBuilder(["MODEL_API_KEY"], platform);
      if (!configured.ok) throw new Error(configured.message);

      const environment = configured.build({
        MODEL_API_KEY: "upper-secret",
        model_api_key: "lower-secret",
        Model_Api_Key: "mixed-secret",
        MODEL_API_KEY_BACKUP: "task-backup",
        GH_TOKEN: "task-token",
      });

      expect(environment).toEqual(
        platform === "win32"
          ? { MODEL_API_KEY_BACKUP: "task-backup", GH_TOKEN: "task-token" }
          : {
              model_api_key: "lower-secret",
              Model_Api_Key: "mixed-secret",
              MODEL_API_KEY_BACKUP: "task-backup",
              GH_TOKEN: "task-token",
            },
      );
    },
  );

  it("keeps the configured name set even if its caller later changes the array", () => {
    const names = ["MODEL_API_KEY"];
    const configured = createChildEnvironmentBuilder(names);
    if (!configured.ok) throw new Error(configured.message);
    names[0] = "GH_TOKEN";
    names.length = 0;

    expect(configured.build({ MODEL_API_KEY: "secret", GH_TOKEN: "task-token" })).toEqual({
      GH_TOKEN: "task-token",
    });
  });

  it("leaves the parent untouched and produces an independent copy each time", () => {
    const configured = createChildEnvironmentBuilder(["MODEL_API_KEY"]);
    if (!configured.ok) throw new Error(configured.message);
    const parent = { MODEL_API_KEY: "secret", GH_TOKEN: "task-token" };
    const first = configured.build(parent);
    first.GH_TOKEN = "child-change";

    expect({ parent, next: configured.build(parent) }).toEqual({
      parent: { MODEL_API_KEY: "secret", GH_TOKEN: "task-token" },
      next: { GH_TOKEN: "task-token" },
    });
  });
});
