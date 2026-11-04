import type { PrepareOutcome, ToolError, ToolOutcome } from "@coding-agent/agent-core";
import type { TSchema } from "typebox";

// Every tool reports through these three, so a Tool Result is worded and shaped the same way
// whichever tool produced it.
export function success(content: string): ToolOutcome {
  return { isError: false, content };
}

export function toolError(error: ToolError): ToolOutcome {
  return { isError: true, content: error.message, error };
}

export function prepareFailure<S extends TSchema>(error: ToolError): PrepareOutcome<S> {
  return { ok: false, code: error.code, message: error.message };
}
