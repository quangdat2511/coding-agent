import { describe, expect, it } from "bun:test";
import type { ToolResult } from "@coding-agent/agent-core";

describe("agent-core types", () => {
  it("resolve from tools without a paths entry for agent-core", () => {
    const result: ToolResult = {
      toolCallId: "call-1",
      toolName: "read",
      content: "",
      isError: true,
      error: { code: "NOT_FOUND", message: "missing.txt does not exist" },
    };

    expect(result.error?.code).toBe("NOT_FOUND");
  });
});
