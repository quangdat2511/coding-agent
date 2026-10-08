import type { SessionLimits } from "./ports.ts";
import type { OpenSessionConfig } from "./session.ts";
import type { ExecutableTool, ToolRegistry } from "./tool.ts";

export interface ConfigProblem {
  readonly field?: string;
  readonly message: string;
}

type Fields = Readonly<Record<string, unknown>>;
type Check = (value: unknown) => ConfigProblem | undefined;

const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

const problem = (field: string, message: string): ConfigProblem => ({ field, message });

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

function checkModel(model: Fields): ConfigProblem | undefined {
  const { identity, capabilities } = model;
  if (
    !isObject(identity) ||
    !["id", "name", "provider"].every((key) => isNonEmptyString(identity[key]))
  ) {
    return problem("model.identity", "model.identity needs a non-empty id, name and provider");
  }
  if (
    !isObject(capabilities) ||
    typeof capabilities.parallelToolCallControl !== "boolean" ||
    (capabilities.cancellation !== "client_abort_only" &&
      capabilities.cancellation !== "native_in_flight")
  ) {
    return problem(
      "model.capabilities",
      "model.capabilities must declare parallelToolCallControl and a known cancellation mode",
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
  if (mutation !== "read_only" && mutation !== "mutating") {
    return problem(
      `${field}.mutation`,
      `${field}.mutation of "${name}" must be "read_only" or "mutating"`,
    );
  }
  return checkPort(field, tool, ["prepare", "execute"]);
}

function checkTools(value: unknown): ConfigProblem | undefined {
  const missing = checkPort("tools", value, ["get", "list"]);
  if (missing) return missing;
  const registry = value as ToolRegistry;
  const listed: unknown = registry.list();
  if (!Array.isArray(listed)) return problem("tools.list", "tools.list() must return an array");

  const names = new Set<string>();
  for (const [index, tool] of listed.entries()) {
    const found = checkTool(`tools[${index}]`, tool);
    if (found) return found;
    const { name } = tool as ExecutableTool;
    if (names.has(name)) return problem("tools", `tools lists more than one tool named "${name}"`);
    names.add(name);
  }

  const unreachable = (listed as ExecutableTool[]).find((tool) => registry.get(tool.name) !== tool);
  return unreachable === undefined
    ? undefined
    : problem("tools.get", `tools.get("${unreachable.name}") must return the listed tool`);
}

function checkWorkspace(value: unknown): ConfigProblem | undefined {
  const missing = checkPort("workspace", value, ["resolveExisting", "resolveForCreate"]);
  if (missing) return missing;
  const { repoRoot } = value as Fields;
  return typeof repoRoot === "string" && /^(?:\/|[A-Za-z]:[\\/])/.test(repoRoot)
    ? undefined
    : problem("workspace.repoRoot", "workspace.repoRoot must be an absolute path");
}

const limitNames = {
  maxModelTurns: true,
  maxToolCalls: true,
  maxDurationMs: true,
  maxConsecutiveRecoverableFailures: true,
  cancellationGraceMs: true,
} satisfies Record<keyof SessionLimits, true>;

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
  model: (value) => checkPort("model", value, ["stream"]) ?? checkModel(value as Fields),
  systemPrompt: (value) =>
    typeof value === "string"
      ? undefined
      : problem("systemPrompt", "systemPrompt must be a string"),
  tools: checkTools,
  workspace: checkWorkspace,
  approvalPolicy: (value) =>
    value === "ask" || value === "auto-approve"
      ? undefined
      : problem("approvalPolicy", 'approvalPolicy must be "ask" or "auto-approve"'),
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
