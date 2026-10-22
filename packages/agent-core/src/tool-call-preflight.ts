import { Value } from "typebox/value";
import { isOneOf, isRecord, messageOf } from "./guards.ts";
import type { NormalizedToolCall } from "./state.ts";
import type {
  ExecutableTool,
  PrepareContext,
  PreparedCall,
  PrepareOutcome,
  ToolRegistry,
} from "./tool.ts";
import type { ToolError, ToolErrorCode } from "./tool-result.ts";

export interface PreflightContext extends PrepareContext {
  readonly tools: ToolRegistry;
  readonly toolNames: readonly string[];
}

export type PreflightOutcome =
  | { readonly ok: true; readonly tool: ExecutableTool; readonly prepared: PreparedCall }
  | { readonly ok: false; readonly error: ToolError };

const toolErrorCodes = {
  SCHEMA_VIOLATION: true,
  NOT_FOUND: true,
  IS_DIRECTORY: true,
  PATH_OUTSIDE_REPO: true,
  PERMISSION_DENIED: true,
  NO_MATCH: true,
  AMBIGUOUS_MATCH: true,
  PARENT_CREATION_FAILED: true,
  TIMEOUT: true,
  SIGNAL: true,
  NON_ZERO_EXIT: true,
  APPROVAL_DENIED: true,
  TOOL_INTERNAL_ERROR: true,
} satisfies Record<ToolErrorCode, true>;

const isPrepareOutcome = (outcome: unknown): outcome is PrepareOutcome => {
  if (!isRecord(outcome)) return false;
  if (outcome.ok === false) {
    return isOneOf(toolErrorCodes, outcome.code) && typeof outcome.message === "string";
  }
  const { prepared } = outcome;
  return (
    outcome.ok === true &&
    isRecord(prepared) &&
    typeof prepared.summary === "string" &&
    Array.isArray(prepared.paths) &&
    prepared.paths.every((path) => typeof path === "string")
  );
};

const rejected = (code: ToolErrorCode, message: string): PreflightOutcome => ({
  ok: false,
  error: { code, message },
});

const unexpected = (toolName: string, detail: string): PreflightOutcome =>
  rejected(
    "TOOL_INTERNAL_ERROR",
    `${toolName} failed unexpectedly while preparing the call: ${detail}`,
  );

export async function preflightToolCall(
  call: NormalizedToolCall,
  { tools, toolNames, workspace, signal }: PreflightContext,
): Promise<PreflightOutcome> {
  const tool = tools.get(call.name);
  if (tool === undefined) {
    return rejected(
      "NOT_FOUND",
      `unknown tool "${call.name}"; the available tools are ${toolNames.join(", ")}`,
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(call.arguments);
  } catch (error) {
    return rejected(
      "SCHEMA_VIOLATION",
      `the arguments for ${call.name} are not valid JSON: ${messageOf(error)}`,
    );
  }

  let problems: readonly string[] | undefined;
  try {
    if (!Value.Check(tool.parameters, input)) {
      problems = Value.Errors(tool.parameters, input).map(
        ({ instancePath, message }) => `arguments${instancePath} ${message}`,
      );
    }
  } catch (error) {
    return rejected(
      "TOOL_INTERNAL_ERROR",
      `the parameter schema of ${call.name} could not be evaluated: ${messageOf(error)}`,
    );
  }
  if (problems !== undefined) {
    return rejected(
      "SCHEMA_VIOLATION",
      `Schema Validation failed for ${call.name}: ${problems.join("; ")}`,
    );
  }

  let outcome: unknown;
  try {
    outcome = await tool.prepare(input, { workspace, signal });
  } catch (error) {
    return unexpected(call.name, messageOf(error));
  }
  if (!isPrepareOutcome(outcome)) {
    return unexpected(call.name, "prepare returned an unusable outcome");
  }
  if (!outcome.ok) return rejected(outcome.code, outcome.message);
  return { ok: true, tool, prepared: outcome.prepared };
}
