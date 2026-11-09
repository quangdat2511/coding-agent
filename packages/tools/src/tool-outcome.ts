import type { PrepareOutcome, ToolError, ToolOutcome } from "@coding-agent/agent-core";
import type { TSchema } from "typebox";
import { boundToolOutput } from "./output-budget.ts";

// Every tool reports through these three, so a Tool Result is worded and shaped the same way
// whichever tool produced it.
export function success(content: string): ToolOutcome {
  // The shared budget (ADR 0001 §3) applies here, where every tool's successful content becomes a
  // Tool Outcome, so no successful result can flood the context window. Agent Core copies the flag
  // into the Tool Result's metadata.
  const bounded = boundToolOutput(content);
  return bounded.truncated
    ? { isError: false, content: bounded.content, truncated: true }
    : { isError: false, content };
}

export function toolError(error: ToolError): ToolOutcome {
  // A failed command can carry as much output as a successful one, so the same budget applies and
  // the message stays identical to the content the model sees.
  const bounded = boundToolOutput(error.message);
  return bounded.truncated
    ? {
        isError: true,
        content: bounded.content,
        error: { code: error.code, message: bounded.content },
        truncated: true,
      }
    : { isError: true, content: error.message, error };
}

export function prepareFailure<S extends TSchema>(error: ToolError): PrepareOutcome<S> {
  return { ok: false, code: error.code, message: error.message };
}
