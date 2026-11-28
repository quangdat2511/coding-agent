// A real Agent Run over a scripted model and a fake mutating tool, so the interactive path is
// tested against the Agent Run it will drive, with a pending Approval and nothing from a provider.
import {
  type AgentRun,
  type ExecutableTool,
  type ModelPort,
  openAgentRun,
  type RepoPath,
  type RunCommand,
  type ToolRegistry,
} from "@coding-agent/agent-core";
import type {
  AssistantMessage,
  ModelStream,
  ModelStreamEvent,
  ToolCallBlock,
} from "@coding-agent/ai";
import { BashParams } from "@coding-agent/tools";
import type { AgentRunConfig, AgentRunFactoryResult } from "../../src/agent-run-factory.ts";
import { transcriptWording } from "../../src/transcript-wording.ts";

const usage = { inputTokens: 1, outputTokens: 1 };

const message = (content: AssistantMessage["content"], reason: "tool_call" | "end_turn") =>
  ({
    role: "assistant",
    content,
    model: "scripted",
    finishReason: { reason, rawReason: reason },
    usage,
  }) satisfies AssistantMessage;

function turn(events: readonly ModelStreamEvent[], result: AssistantMessage): ModelStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: async () => result,
  };
}

function textTurn(text: string): ModelStream {
  const result = message([{ type: "text", text }], "end_turn");
  return turn(
    [
      { type: "stream_start" },
      { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "turn_end", message: result },
    ],
    result,
  );
}

// Turn 1 asks to run `bun test`, which needs an Approval; turn 2 answers with `answer`.
function scriptedModel(answer: string): ModelPort {
  const call: ToolCallBlock = {
    type: "tool_call",
    toolCallId: "provider-call",
    name: "bash",
    arguments: JSON.stringify({ command: "bun test" }),
  };
  const first = message([call], "tool_call");
  const turns = [
    turn(
      [
        { type: "stream_start" },
        { type: "content_block_start", index: 0, block: call },
        { type: "content_block_stop", index: 0 },
        { type: "turn_end", message: first },
      ],
      first,
    ),
    textTurn(answer),
  ];
  return {
    identity: { id: "scripted", name: "Scripted", provider: "scripted" },
    capabilities: {
      parallelToolCallControl: true,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "whole",
      usageTiming: "final",
      serverSideTools: false,
    },
    stream: () => {
      const next = turns.shift();
      if (!next) throw new Error("the scripted model has no more turns");
      return next;
    },
  };
}

const fakeBash: ExecutableTool<typeof BashParams> = {
  name: "bash",
  description: "Runs a command.",
  parameters: BashParams,
  mutation: "mutating",
  prepare: async (input) => ({
    ok: true,
    prepared: { input, paths: [], summary: `Run ${input.command}` },
  }),
  execute: async () => ({ isError: false, content: "1 pass" }),
};

export interface ScriptedAgentOptions {
  // What the second model turn says.
  readonly answer?: string;
  // Records "events(<after>)" and "dispatch:<type>" (plus ":<reason>" of a cancel) in order.
  readonly calls?: string[];
  // The approval policy and limits the host asked for, one entry per opened Agent Run.
  readonly configs?: AgentRunConfig[];
}

export function scriptedAgent({
  answer = "All tests pass.",
  calls,
  configs,
}: ScriptedAgentOptions = {}) {
  let ids = 0;
  const repoRoot = "/repo" as RepoPath;
  const tools: ToolRegistry = {
    get: (name) => (name === "bash" ? (fakeBash as ExecutableTool) : undefined),
    list: () => [fakeBash as ExecutableTool],
  };
  return async (config: AgentRunConfig): Promise<AgentRunFactoryResult> => {
    configs?.push(config);
    const opened = openAgentRun({
      model: scriptedModel(answer),
      systemPrompt: "Test.",
      tools,
      workspace: {
        repoRoot,
        resolveExisting: async () => ({ ok: true, path: repoRoot }),
        resolveForCreate: async () => ({ ok: true, path: repoRoot }),
      },
      approvalPolicy: config.approvalPolicy,
      verification: { verify: async () => ({ outcome: "succeeded", evidence: [] }) },
      limits: { ...config.limits, maxDurationMs: 60_000 },
      clock: {
        now: () => "2026-11-18T00:00:00.000Z",
        monotonicMs: () => 0,
        setTimer: (delayMs, callback) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      ids: { next: (kind) => `${kind}-${++ids}` },
      wording: transcriptWording,
    });
    if (!opened.ok) return opened;
    const { run } = opened;
    const observed: AgentRun = {
      dispatch: (command: RunCommand) => {
        const reason = command.type === "cancel" && command.reason ? `:${command.reason}` : "";
        calls?.push(`dispatch:${command.type}${reason}`);
        return run.dispatch(command);
      },
      snapshot: () => run.snapshot(),
      events: (after) => {
        calls?.push(`events(${after})`);
        return run.events(after);
      },
      result: () => run.result(),
    };
    return {
      ok: true,
      run: observed,
      systemPrompt: "Test.",
      toolNames: ["bash"],
      skippedInstructions: [],
    };
  };
}
