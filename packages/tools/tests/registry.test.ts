import { describe, expect, it } from "bun:test";
import { createChildProcessLauncher, createDefaultTools } from "../src/index.ts";

describe("the default registry", () => {
  it("exposes the read, write, edit, and bash tools by name", () => {
    const configured = createChildProcessLauncher(["CDA71_PROVIDER_KEY"]);
    if (!configured.ok) throw new Error(configured.message);
    const registry = createDefaultTools(configured.launcher);

    expect(registry.list().map((tool) => tool.name)).toEqual(["read", "write", "edit", "bash"]);
    expect(registry.get("read")?.name).toBe("read");
    expect(registry.get("write")?.name).toBe("write");
    expect(registry.get("edit")?.name).toBe("edit");
    expect(registry.get("bash")?.mutation).toBe("mutating");
  });
});
