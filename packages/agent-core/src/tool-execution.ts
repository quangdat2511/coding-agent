import { isRecord, messageOf } from "./guards.ts";
import type { ExecutableTool, ExecuteContext, PreparedCall, ToolOutcome } from "./tool.ts";
import { isToolError } from "./tool-call-preflight.ts";

const isToolOutcome = (outcome: unknown): outcome is ToolOutcome =>
  isRecord(outcome) &&
  typeof outcome.content === "string" &&
  (outcome.truncated === undefined || typeof outcome.truncated === "boolean") &&
  (outcome.isError === false || (outcome.isError === true && isToolError(outcome.error)));

const unexpected = (toolName: string, detail: string): ToolOutcome => {
  const message = `${toolName} failed unexpectedly while executing the call: ${detail}`;
  return { isError: true, content: message, error: { code: "TOOL_INTERNAL_ERROR", message } };
};

export async function executeTool(
  tool: ExecutableTool,
  prepared: PreparedCall,
  ctx: ExecuteContext,
): Promise<ToolOutcome> {
  let outcome: unknown;
  try {
    outcome = await tool.execute(prepared, ctx);
  } catch (error) {
    return unexpected(tool.name, messageOf(error));
  }
  if (!isToolOutcome(outcome)) return unexpected(tool.name, "execute returned an unusable outcome");
  const truncated = outcome.truncated === undefined ? {} : { truncated: outcome.truncated };
  return outcome.isError
    ? {
        isError: true,
        content: outcome.content,
        error: { code: outcome.error.code, message: outcome.error.message },
        ...truncated,
      }
    : { isError: false, content: outcome.content, ...truncated };
}
