import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ModelPort,
  openAgentSession,
  type SessionEvent,
  type ToolRegistry,
} from "@coding-agent/agent-core";
import type {
  AssistantMessage,
  ModelStream,
  ModelStreamEvent,
  ToolCallBlock,
} from "@coding-agent/ai";
import { bashTool, createWorkspaceResolver } from "@coding-agent/tools";
import { createConfiguredChildLauncher } from "../src/child-launcher.ts";

let repo: string;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "bash-progress-")));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const usage = { inputTokens: 1, outputTokens: 1 };

function streamOf(events: readonly ModelStreamEvent[], message: AssistantMessage): ModelStream {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    result: async () => message,
  };
}

// A model that asks for one bash command, then finishes.
function scriptedModel(command: string): ModelPort {
  const block: ToolCallBlock = {
    type: "tool_call",
    toolCallId: "call-1",
    name: "bash",
    arguments: JSON.stringify({ command }),
  };
  const call: AssistantMessage = {
    role: "assistant",
    content: [block],
    model: "scripted",
    finishReason: { reason: "tool_call", rawReason: "tool_use" },
    usage,
  };
  const done: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    model: "scripted",
    finishReason: { reason: "end_turn", rawReason: "stop" },
    usage,
  };
  const turns = [
    streamOf(
      [
        { type: "stream_start" },
        { type: "content_block_start", index: 0, block },
        { type: "content_block_stop", index: 0 },
        { type: "turn_end", message: call },
      ],
      call,
    ),
    streamOf(
      [
        { type: "stream_start" },
        { type: "content_block_start", index: 0, block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
        { type: "content_block_stop", index: 0 },
        { type: "turn_end", message: done },
      ],
      done,
    ),
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

describe("bash progress in an Agent Session", () => {
  it("reaches observers as bounded tool_execution_progress events, none after completion", async () => {
    const configured = createConfiguredChildLauncher();
    if (!configured.ok) throw new Error(configured.message);
    const created = await createWorkspaceResolver(repo);
    if (!created.ok) throw new Error(created.message);
    const bash = bashTool(configured.launcher);
    const tools: ToolRegistry = {
      get: (name) => (name === "bash" ? bash : undefined),
      list: () => [bash],
    };
    // A burst of 4 KiB, a pause long enough for the held update to be delivered, then more.
    const command = "head -c 4096 /dev/zero | tr '\\0' a; echo; sleep 0.6; echo second";

    const opened = openAgentSession({
      model: scriptedModel(command),
      systemPrompt: "Test.",
      tools,
      workspace: created.workspace,
      approvalPolicy: "auto-approve",
      verification: {
        verify: async ({ workspaceChanged }) => ({
          outcome: "succeeded",
          evidence: [{ type: "no_command_configured", workspaceChanged }],
        }),
      },
      limits: {
        maxModelTurns: 5,
        maxToolCalls: 5,
        maxDurationMs: 60_000,
        maxConsecutiveRecoverableFailures: 3,
        cancellationGraceMs: 5_000,
      },
      clock: {
        now: () => new Date().toISOString(),
        monotonicMs: () => Math.floor(performance.now()),
        setTimer: (delayMs, callback) => {
          const timer = setTimeout(callback, delayMs);
          return () => clearTimeout(timer);
        },
      },
      ids: { next: (kind) => `${kind}-1` },
    });
    if (!opened.ok) throw new Error(opened.message);
    const { session } = opened;
    const events: SessionEvent[] = [];
    const observed = (async () => {
      for await (const event of session.events()) events.push(event);
    })();

    await session.dispatch({ type: "start", task: { objective: "Run the build" } });
    const result = await session.result();
    await observed;

    expect(result.outcome).toBe("succeeded");
    const types = events.map((event) => event.type);
    const started = types.indexOf("tool_execution_started");
    const completed = types.indexOf("tool_call_completed");
    const progress = events.flatMap((event, index) =>
      event.type === "tool_execution_progress" ? [{ index, output: event.data.update.output }] : [],
    );

    expect(progress.length).toBeGreaterThan(0);
    for (const { index, output } of progress) {
      expect(index).toBeGreaterThan(started);
      expect(index).toBeLessThan(completed);
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(2_048);
    }
    // The burst is bounded to its last 2 KiB, and the pause lets the newest output through.
    expect(progress.some(({ output }) => output === `${"a".repeat(2_047)}\n`)).toBe(true);
  });
});
