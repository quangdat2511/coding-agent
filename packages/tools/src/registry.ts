import type { ExecutableTool, ToolRegistry } from "@coding-agent/agent-core";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

// The registry the composition root hands to an Agent Session. A harness that needs fewer tools
// composes its own from the individually exported ones.
export function createDefaultTools(): ToolRegistry {
  const tools: readonly ExecutableTool[] = [readTool(), writeTool()];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    get: (name) => byName.get(name),
    list: () => tools,
  };
}
