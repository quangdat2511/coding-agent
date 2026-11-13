import { describe, expect, it } from "bun:test";
import { type OpenSessionConfig, openAgentSession, type RepoPath } from "../src/index.ts";
import {
  abortIgnoringTool,
  createTestKit,
  fakeTool,
  throwingTool,
  toolRegistry,
} from "./kit/index.ts";

describe("opening an Agent Session", () => {
  it("returns a ready Agent Session that has emitted no Session Event", () => {
    const { config } = createTestKit({
      tools: [
        fakeTool({ name: "read" }),
        throwingTool({ name: "write", mutation: "mutating" }),
        throwingTool({ name: "edit", mutation: "mutating", failure: "reject" }),
        abortIgnoringTool({ name: "bash" }),
      ],
    });

    const opened = openAgentSession(config);
    if (!opened.ok) throw new Error(`expected a session, got: ${opened.message}`);

    expect(opened.session.snapshot()).toEqual({
      phase: "ready",
      sessionId: "session-1",
      transcript: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      counters: { modelTurns: 0, toolCalls: 0, consecutiveRecoverableFailures: 0 },
      activeDurationMs: 0,
      workspaceChanged: false,
      partialChangesPossible: false,
      lastSequence: 0,
    });
  });

  it("accepts a Windows drive as the repository root", () => {
    const { config } = createTestKit();

    const opened = openAgentSession({
      ...config,
      workspace: { ...config.workspace, repoRoot: "C:\\repo" as RepoPath },
    });

    expect(opened.ok).toBe(true);
  });

  it("accepts a registry that hands out wrappers of its listed tools", () => {
    const { config } = createTestKit();
    const read = fakeTool({ name: "read" });

    const opened = openAgentSession({
      ...config,
      tools: { get: (name) => (name === "read" ? { ...read } : undefined), list: () => [read] },
    });

    expect(opened.ok).toBe(true);
  });

  it("accepts limits of one", () => {
    const { config } = createTestKit({
      limits: {
        maxModelTurns: 1,
        maxToolCalls: 1,
        maxDurationMs: 1,
        maxConsecutiveRecoverableFailures: 1,
        cancellationGraceMs: 1,
      },
    });

    expect(openAgentSession(config).ok).toBe(true);
  });

  it("accepts a model that cancels in flight and cannot control parallel tool calls", () => {
    const { config } = createTestKit({
      model: {
        capabilities: { cancellation: "native_in_flight", parallelToolCallControl: false },
      },
    });

    expect(config.model.capabilities.cancellation).toBe("native_in_flight");
    expect(openAgentSession(config).ok).toBe(true);
  });
});

describe("refusing an invalid configuration", () => {
  type Change = (config: OpenSessionConfig) => object;

  const expectRefusal = (change: Change, field: string) => {
    const kit = createTestKit();
    const config = { ...kit.config, ...change(kit.config) } as unknown as OpenSessionConfig;

    const opened = openAgentSession(config);

    expect(opened).toEqual({
      ok: false,
      code: "INVALID_CONFIGURATION",
      message: expect.stringContaining(field),
      field,
    });
    expect(kit.portCalls).toEqual([]);
  };

  it("refuses a configuration that is not an object, naming no field", () => {
    const opened = openAgentSession(null as unknown as OpenSessionConfig);

    expect(opened).toEqual({
      ok: false,
      code: "INVALID_CONFIGURATION",
      message: expect.stringContaining("configuration"),
    });
  });

  it.each([
    { field: "model", change: () => ({ model: undefined }) },
    { field: "systemPrompt", change: () => ({ systemPrompt: undefined }) },
    { field: "tools", change: () => ({ tools: undefined }) },
    { field: "workspace", change: () => ({ workspace: undefined }) },
    { field: "approvalPolicy", change: () => ({ approvalPolicy: undefined }) },
    { field: "verification", change: () => ({ verification: undefined }) },
    { field: "limits", change: () => ({ limits: undefined }) },
    { field: "clock", change: () => ({ clock: null }) },
    { field: "ids", change: () => ({ ids: "sequential" }) },
  ] satisfies { field: string; change: Change }[])(
    "refuses a missing $field and touches no port",
    ({ field, change }) => expectRefusal(change, field),
  );

  it.each([
    {
      problem: "a model that cannot stream",
      field: "model.stream",
      change: (config) => ({ model: { ...config.model, stream: undefined } }),
    },
    {
      problem: "a model without an identity",
      field: "model.identity",
      change: (config) => ({ model: { ...config.model, identity: { name: "Nameless" } } }),
    },
    {
      problem: "a model with an unknown cancellation capability",
      field: "model.capabilities",
      change: (config) => ({
        model: {
          ...config.model,
          capabilities: { ...config.model.capabilities, cancellation: "polite" },
        },
      }),
    },
    {
      problem: "a tool registry that cannot list its tools",
      field: "tools.list",
      change: (config) => ({ tools: { get: config.tools.get } }),
    },
    {
      problem: "a tool registry that cannot look a tool up",
      field: "tools.get",
      change: (config) => ({ tools: { list: config.tools.list } }),
    },
    {
      problem: "a workspace that cannot resolve existing paths",
      field: "workspace.resolveExisting",
      change: (config) => ({ workspace: { ...config.workspace, resolveExisting: undefined } }),
    },
    {
      problem: "a workspace that cannot resolve paths to create",
      field: "workspace.resolveForCreate",
      change: (config) => ({ workspace: { ...config.workspace, resolveForCreate: "nope" } }),
    },
    {
      problem: "an unknown approval policy",
      field: "approvalPolicy",
      change: () => ({ approvalPolicy: "bypass" }),
    },
    {
      problem: "a verification policy that cannot verify",
      field: "verification.verify",
      change: () => ({ verification: {} }),
    },
    {
      problem: "a clock without monotonic time",
      field: "clock.monotonicMs",
      change: (config) => ({ clock: { now: config.clock.now } }),
    },
    {
      problem: "a clock that cannot set timers",
      field: "clock.setTimer",
      change: (config) => ({
        clock: { now: config.clock.now, monotonicMs: config.clock.monotonicMs },
      }),
    },
    {
      problem: "an id source that cannot issue ids",
      field: "ids.next",
      change: () => ({ ids: {} }),
    },
    {
      problem: "a system prompt that is not text",
      field: "systemPrompt",
      change: () => ({ systemPrompt: 42 }),
    },
  ] satisfies { problem: string; field: string; change: Change }[])(
    "refuses $problem, naming $field",
    ({ field, change }) => expectRefusal(change, field),
  );

  it.each([
    { limit: "maxModelTurns", value: 0, label: "zero" },
    { limit: "maxToolCalls", value: -1, label: "a negative number" },
    { limit: "maxDurationMs", value: Number.POSITIVE_INFINITY, label: "infinity" },
    { limit: "maxConsecutiveRecoverableFailures", value: 1.5, label: "a fraction" },
    { limit: "cancellationGraceMs", value: undefined, label: "nothing" },
    { limit: "maxModelTurns", value: Number.NaN, label: "NaN" },
    { limit: "maxToolCalls", value: "100", label: "a string" },
  ])("refuses limits.$limit set to $label", ({ limit, value }) =>
    expectRefusal(
      (config) => ({ limits: { ...config.limits, [limit]: value } }),
      `limits.${limit}`,
    ),
  );

  it.each([
    {
      problem: "a registry whose list is not an array",
      field: "tools.list",
      tools: () => ({ get: () => undefined, list: () => "read" }),
    },
    {
      problem: "a tool without a name",
      field: "tools[0].name",
      tools: () => toolRegistry({ ...fakeTool(), name: "" }),
    },
    {
      problem: "a tool without a description",
      field: "tools[0].description",
      tools: () => toolRegistry({ ...fakeTool(), description: undefined } as never),
    },
    {
      problem: "a tool without a parameter schema",
      field: "tools[0].parameters",
      tools: () => toolRegistry({ ...fakeTool(), parameters: undefined } as never),
    },
    {
      problem: "a tool with an unknown mutation",
      field: "tools[1].mutation",
      tools: () =>
        toolRegistry(fakeTool({ name: "read" }), {
          ...fakeTool({ name: "write" }),
          mutation: "destructive",
        } as never),
    },
    {
      problem: "a tool that cannot prepare",
      field: "tools[0].prepare",
      tools: () => toolRegistry({ ...fakeTool(), prepare: undefined } as never),
    },
    {
      problem: "a tool that cannot execute",
      field: "tools[0].execute",
      tools: () => toolRegistry({ ...fakeTool(), execute: undefined } as never),
    },
    {
      problem: "two tools with the same name",
      field: "tools",
      tools: () => toolRegistry(fakeTool({ name: "read" }), fakeTool({ name: "read" })),
    },
    {
      problem: "a registry that does not return a listed tool",
      field: "tools.get",
      tools: () => ({ get: () => undefined, list: () => [fakeTool({ name: "read" })] }),
    },
    {
      problem: "a registry whose get returns a copy that cannot execute",
      field: 'tools.get("read").execute',
      tools: () => {
        const read = fakeTool({ name: "read" });
        return { get: () => ({ ...read, execute: undefined }), list: () => [read] };
      },
    },
  ])("refuses $problem, naming $field", ({ field, tools }) =>
    expectRefusal(() => ({ tools: tools() }), field),
  );

  it.each([
    { problem: "a relative repository root", repoRoot: "repo" },
    { problem: "an empty repository root", repoRoot: "" },
    { problem: "a missing repository root", repoRoot: undefined },
  ])("refuses $problem, naming workspace.repoRoot", ({ repoRoot }) =>
    expectRefusal(
      (config) => ({ workspace: { ...config.workspace, repoRoot } }),
      "workspace.repoRoot",
    ),
  );

  it("refuses an id source that issues an empty session id, naming ids", () =>
    expectRefusal(() => ({ ids: { next: () => "" } }), "ids"));

  const fail = () => {
    throw new Error("broken port");
  };

  it.each([
    {
      problem: "a registry whose list throws",
      field: "tools.list",
      change: (config) => ({ tools: { ...config.tools, list: fail } }),
    },
    {
      problem: "a registry whose get throws",
      field: "tools.get",
      change: (config) => ({ tools: { ...config.tools, get: fail } }),
    },
    {
      problem: "an id source that throws",
      field: "ids",
      change: () => ({ ids: { next: fail } }),
    },
  ] satisfies { problem: string; field: string; change: Change }[])(
    "refuses $problem instead of throwing, naming $field",
    ({ field, change }) => expectRefusal(change, field),
  );
});
