import type { ExecutableTool, ToolRegistry } from "@coding-agent/agent-core";
import { bashTool } from "./bash.ts";
import type { ChildProcessLauncher } from "./child-process.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

// The registry the composition root hands to an Agent Session. bash starts its commands through
// the launcher, which strips provider credentials from every child (ADR 0001 §8). A harness that
// needs fewer tools composes its own from the individually exported ones.
export function createDefaultTools(launcher: ChildProcessLauncher): ToolRegistry {
  const tools: readonly ExecutableTool[] = [
    readTool(),
    writeTool(),
    editTool(),
    bashTool(launcher),
  ];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    get: (name) => byName.get(name),
    list: () => tools,
  };
}
