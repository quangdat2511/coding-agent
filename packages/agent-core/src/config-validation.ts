import type { ApprovalPolicy, IdSource, ModelPort, SessionLimits } from "./ports.ts";
import type { OpenSessionConfig, OpenSessionResult } from "./session.ts";
import type { ExecutableTool, ToolMutation, ToolRegistry } from "./tool.ts";

export type ConfigProblem = Pick<Extract<OpenSessionResult, { ok: false }>, "field" | "message">;

type Fields = Readonly<Record<string, unknown>>;
type Check = (value: unknown) => ConfigProblem | undefined;

const cancellationModes = {
  client_abort_only: true,
  native_in_flight: true,
} satisfies Record<ModelPort["capabilities"]["cancellation"], true>;

const toolMutations = { read_only: true, mutating: true } satisfies Record<ToolMutation, true>;

const approvalPolicies = { ask: true, "auto-approve": true } satisfies Record<ApprovalPolicy, true>;

const limitNames = {
  maxModelTurns: true,
  maxToolCalls: true,
  maxDurationMs: true,
  maxConsecutiveRecoverableFailures: true,
  cancellationGraceMs: true,
} satisfies Record<keyof SessionLimits, true>;

const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const isOneOf = (options: object, value: unknown): boolean =>
  typeof value === "string" && Object.hasOwn(options, value);

const isAbsolutePath = (value: unknown): boolean =>
  typeof value === "string" && /^(?:\/|[A-Za-z]:[\\/])/.test(value);

const oneOf = (options: object): string => Object.keys(options).join(", ");

const problem = (field: string, message: string): ConfigProblem => ({ field, message });

const threw = (field: string, error: unknown): ConfigProblem =>
  problem(field, `${field} threw: ${error instanceof Error ? error.message : String(error)}`);

function checkPort(
  field: string,
  value: unknown,
  methods: readonly string[],
): ConfigProblem | undefined {
  if (!isObject(value)) return problem(field, `${field} is required`);
  const missing = methods.find((method) => typeof value[method] !== "function");
  return missing === undefined
    ? undefined
    : problem(`${field}.${missing}`, `${field}.${missing} must be a function`);
}

function checkModel(value: unknown): ConfigProblem | undefined {
  const missing = checkPort("model", value, ["stream"]);
  if (missing) return missing;
  const { identity, capabilities } = value as Fields;
  if (
    !isObject(identity) ||
    !["id", "name", "provider"].every((key) => isNonEmptyString(identity[key]))
  ) {
    return problem("model.identity", "model.identity needs a non-empty id, name and provider");
  }
  if (
    !isObject(capabilities) ||
    typeof capabilities.parallelToolCallControl !== "boolean" ||
    !isOneOf(cancellationModes, capabilities.cancellation)
  ) {
    return problem(
      "model.capabilities",
      `model.capabilities must declare parallelToolCallControl and a cancellation of ${oneOf(cancellationModes)}`,
    );
  }
  return undefined;
}

function checkTool(field: string, tool: unknown): ConfigProblem | undefined {
  if (!isObject(tool)) return problem(field, `${field} must be a tool`);
  const { name, description, parameters, mutation } = tool;
  if (!isNonEmptyString(name)) return problem(`${field}.name`, `${field}.name must be non-empty`);
  if (typeof description !== "string") {
    return problem(`${field}.description`, `${field}.description of "${name}" must be a string`);
  }
  if (!isObject(parameters)) {
    return problem(`${field}.parameters`, `${field}.parameters of "${name}" must be a schema`);
  }
  if (!isOneOf(toolMutations, mutation)) {
    return problem(
      `${field}.mutation`,
      `${field}.mutation of "${name}" must be one of ${oneOf(toolMutations)}`,
    );
  }
  return checkPort(field, tool, ["prepare", "execute"]);
}

function checkTools(value: unknown): ConfigProblem | undefined {
  const missing = checkPort("tools", value, ["get", "list"]);
  if (missing) return missing;
  const registry = value as ToolRegistry;

  let listed: unknown;
  try {
    listed = registry.list();
  } catch (error) {
    return threw("tools.list", error);
  }
  if (!Array.isArray(listed)) return problem("tools.list", "tools.list() must return an array");

  const names = new Set<string>();
  for (const [index, tool] of listed.entries()) {
    const toolProblem = checkTool(`tools[${index}]`, tool);
    if (toolProblem) return toolProblem;
    const { name } = tool as ExecutableTool;
    if (names.has(name)) return problem("tools", `tools lists more than one tool named "${name}"`);
    names.add(name);
  }

  for (const name of names) {
    let found: ExecutableTool | undefined;
    try {
      found = registry.get(name);
    } catch (error) {
      return threw("tools.get", error);
    }
    if (found?.name !== name) {
      return problem("tools.get", `tools.get("${name}") must return the listed tool "${name}"`);
    }
    const toolProblem = checkTool(`tools.get("${name}")`, found);
    if (toolProblem) return toolProblem;
  }
  return undefined;
}

function checkWorkspace(value: unknown): ConfigProblem | undefined {
  const missing = checkPort("workspace", value, ["resolveExisting", "resolveForCreate"]);
  if (missing) return missing;
  return isAbsolutePath((value as Fields).repoRoot)
    ? undefined
    : problem("workspace.repoRoot", "workspace.repoRoot must be an absolute path");
}

function checkLimits(limits: unknown): ConfigProblem | undefined {
  if (!isObject(limits)) return problem("limits", "limits is required");
  const invalid = Object.keys(limitNames).find((name) => {
    const value = limits[name];
    return !(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  });
  return invalid === undefined
    ? undefined
    : problem(`limits.${invalid}`, `limits.${invalid} must be a positive integer`);
}

const checks = {
  model: checkModel,
  systemPrompt: (value) =>
    typeof value === "string"
      ? undefined
      : problem("systemPrompt", "systemPrompt must be a string"),
  tools: checkTools,
  workspace: checkWorkspace,
  approvalPolicy: (value) =>
    isOneOf(approvalPolicies, value)
      ? undefined
      : problem("approvalPolicy", `approvalPolicy must be one of ${oneOf(approvalPolicies)}`),
  verification: (value) => checkPort("verification", value, ["verify"]),
  limits: checkLimits,
  clock: (value) => checkPort("clock", value, ["now", "monotonicMs"]),
  ids: (value) => checkPort("ids", value, ["next"]),
} satisfies Record<keyof OpenSessionConfig, Check>;

export function findConfigProblem(config: unknown): ConfigProblem | undefined {
  if (!isObject(config)) return { message: "configuration is required" };
  for (const [field, check] of Object.entries(checks)) {
    const found = check(config[field]);
    if (found) return found;
  }
  return undefined;
}

export function issueSessionId(ids: IdSource): string | ConfigProblem {
  let sessionId: unknown;
  try {
    sessionId = ids.next("session");
  } catch (error) {
    return threw("ids", error);
  }
  return isNonEmptyString(sessionId)
    ? sessionId
    : problem("ids", 'ids.next("session") must return a non-empty string');
}
