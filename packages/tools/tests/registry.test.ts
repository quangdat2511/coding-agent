import { describe, expect, it } from "bun:test";
import { createDefaultTools } from "../src/index.ts";

describe("the default registry", () => {
  it("exposes the read, write, and edit tools by name", () => {
    const registry = createDefaultTools();

    expect(registry.list().map((tool) => tool.name)).toEqual(["read", "write", "edit"]);
    expect(registry.get("read")?.name).toBe("read");
    expect(registry.get("write")?.name).toBe("write");
    expect(registry.get("edit")?.name).toBe("edit");
  });
});
