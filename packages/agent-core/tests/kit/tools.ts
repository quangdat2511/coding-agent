import { type TSchema, Type } from "typebox";
import type { ExecutableTool, ToolMutation, ToolOutcome, ToolRegistry } from "../../src/index.ts";

export interface FakeToolOptions {
  readonly name?: string;
  readonly mutation?: ToolMutation;
  readonly parameters?: TSchema;
  readonly outcome?: ToolOutcome;
}

export function fakeTool({
  name = "echo",
  mutation = "read_only",
  parameters = Type.Object({}),
  outcome = { isError: false, content: "ok" },
}: FakeToolOptions = {}): ExecutableTool {
  return {
    name,
    description: `Fake ${name} tool`,
    parameters,
    mutation,
    async prepare(input) {
      return {
        ok: true,
        prepared: { input, paths: [], summary: `${name} ${JSON.stringify(input)}` },
      };
    },
    async execute() {
      return outcome;
    },
  };
}

export function throwingTool({
  phase = "execute",
  ...options
}: Omit<FakeToolOptions, "outcome"> & {
  readonly phase?: "prepare" | "execute";
} = {}): ExecutableTool {
  const tool = fakeTool({ name: "explode", ...options });
  const fail = async (): Promise<never> => {
    throw new Error(`${tool.name} threw during ${phase}`);
  };
  return phase === "prepare" ? { ...tool, prepare: fail } : { ...tool, execute: fail };
}

export interface AbortIgnoringTool extends ExecutableTool {
  release(outcome?: ToolOutcome): void;
}

export function abortIgnoringTool(
  options: Omit<FakeToolOptions, "outcome"> = {},
): AbortIgnoringTool {
  const settled = Promise.withResolvers<ToolOutcome>();

  return {
    ...fakeTool({ name: "stubborn", mutation: "mutating", ...options }),
    execute: () => settled.promise,
    release(outcome = { isError: false, content: "finished after abort" }) {
      settled.resolve(outcome);
    },
  };
}

export function toolRegistry(...tools: readonly ExecutableTool[]): ToolRegistry {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { get: (name) => byName.get(name), list: () => tools };
}
