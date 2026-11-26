import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { AgentResult, RunEvent } from "@coding-agent/agent-core";
import { openRunFiles, type RunRecord } from "../src/run-files.ts";
import { withTemporaryDirectory } from "./support/process.ts";

const secret = "sk-test-credential-value";

const redact = (text: string): string => text.replaceAll(secret, "[redacted]");

const run: RunRecord = {
  codingAgent: { version: "0.0.1", commit: null },
  provider: "google",
  model: "gemini-3.5-flash-lite",
  sampling: { maxOutputTokens: null, temperature: null },
  transportRetryBound: 2,
  repoRoot: "/repo",
  profile: "default",
  limits: {
    maxModelTurns: 30,
    maxToolCalls: 100,
    maxDurationMs: 600_000,
    maxConsecutiveRecoverableFailures: 3,
    cancellationGraceMs: 5_000,
  },
  approvalPolicy: "auto-approve",
  verification: { command: null },
  tools: ["read"],
  systemPrompt: "You are Coding Agent.",
};

const agentResult = {
  outcome: "succeeded",
  workspaceChanged: false,
} as unknown as AgentResult;

function event(sequence: number, type: string, data: object): RunEvent {
  return {
    runId: "run-1",
    sequence,
    occurredAt: "2026-11-12T00:00:00.000Z",
    type,
    data,
  } as unknown as RunEvent;
}

async function logged(events: readonly RunEvent[]): Promise<string> {
  return withTemporaryDirectory(async (directory) => {
    const files = await openRunFiles(directory, run, redact);
    await files.logEvents(
      (async function* () {
        yield* events;
      })(),
    );
    await files.close();
    return Bun.file(join(directory, "events.jsonl")).text();
  });
}

describe("the event log", () => {
  it("leaves out content deltas and both kinds of progress, and keeps every other event", async () => {
    const text = await logged([
      event(1, "tool_execution_started", { toolCallId: "call-1", mutation: "read_only" }),
      event(2, "tool_execution_progress", { toolCallId: "call-1", update: {} }),
      event(3, "assistant_content_delta", { messageId: "m", blockIndex: 0, delta: "a" }),
      event(4, "verification_progress", { verificationId: "v", update: {} }),
      event(5, "verification_started", { verificationId: "v" }),
    ]);

    expect(text.trimEnd().split("\n")).toEqual([
      '{"schemaVersion":2,"runId":"run-1","sequence":1,' +
        '"occurredAt":"2026-11-12T00:00:00.000Z","type":"tool_execution_started",' +
        '"data":{"toolCallId":"call-1","mutation":"read_only"}}',
      '{"schemaVersion":2,"runId":"run-1","sequence":5,' +
        '"occurredAt":"2026-11-12T00:00:00.000Z","type":"verification_started",' +
        '"data":{"verificationId":"v"}}',
    ]);
  });

  it("writes the credential neither as a value nor as a property name", async () => {
    const text = await logged([
      event(1, "tool_call_completed", {
        toolCallId: "call-1",
        outcome: "failed",
        result: { error: { [secret]: [`key ${secret}`], nested: { [`x-${secret}`]: 1 } } },
      }),
    ]);

    expect(text).not.toContain(secret);
    expect(JSON.parse(text).data.result.error).toEqual({
      "[redacted]": ["key [redacted]"],
      nested: { "x-[redacted]": 1 },
    });
  });

  it("removes result.details from tool_call_completed before writing events.jsonl, keeping its other fields", async () => {
    const completed = event(1, "tool_call_completed", {
      toolCallId: "call-1",
      outcome: "succeeded",
      result: {
        toolCallId: "call-1",
        toolName: "find",
        content: "src/a.ts",
        isError: false,
        details: { resultLimitReached: 100, incomplete: { exitCode: 2 } },
        metadata: { durationMs: 12 },
      },
    });
    const text = await logged([completed]);
    const parsed = JSON.parse(text.trimEnd());

    expect(parsed).toEqual({
      schemaVersion: 2,
      runId: "run-1",
      sequence: 1,
      occurredAt: "2026-11-12T00:00:00.000Z",
      type: "tool_call_completed",
      data: {
        toolCallId: "call-1",
        outcome: "succeeded",
        result: {
          toolCallId: "call-1",
          toolName: "find",
          content: "src/a.ts",
          isError: false,
          metadata: { durationMs: 12 },
        },
      },
    });
    expect("details" in parsed.data.result).toBe(false);
    // Does not mutate the original event object passed to logEvents.
    expect(
      completed.type === "tool_call_completed" &&
        completed.data.outcome === "succeeded" &&
        completed.data.result?.details,
    ).toEqual({ resultLimitReached: 100, incomplete: { exitCode: 2 } });
  });
});

describe("run.json and result.json records", () => {
  it("omits pricing from run.json and costUsd from result.json when unpriced", async () => {
    await withTemporaryDirectory(async (directory) => {
      const files = await openRunFiles(directory, run, redact);
      await files.writeResult({
        exitCode: 0,
        result: agentResult,
        finishedAt: "2026-11-12T00:00:00.000Z",
      });
      await files.close();

      const runJson = JSON.parse(await Bun.file(join(directory, "run.json")).text());
      const resultJson = JSON.parse(await Bun.file(join(directory, "result.json")).text());

      expect(runJson.schemaVersion).toBe(2);
      expect("pricing" in runJson).toBe(false);

      expect(resultJson.schemaVersion).toBe(2);
      expect("costUsd" in resultJson).toBe(false);
    });
  });

  it("includes pricing in run.json and costUsd in result.json when priced", async () => {
    await withTemporaryDirectory(async (directory) => {
      const pricedRun: RunRecord = {
        ...run,
        pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      };
      const files = await openRunFiles(directory, pricedRun, redact);
      await files.writeResult({
        exitCode: 0,
        result: agentResult,
        finishedAt: "2026-11-12T00:00:00.000Z",
        costUsd: 0.000075,
      });
      await files.close();

      const runJson = JSON.parse(await Bun.file(join(directory, "run.json")).text());
      const resultJson = JSON.parse(await Bun.file(join(directory, "result.json")).text());

      expect(runJson.schemaVersion).toBe(2);
      expect(runJson.pricing).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });

      expect(resultJson.schemaVersion).toBe(2);
      expect(resultJson.costUsd).toBe(0.000075);
    });
  });

  it("records costUsd: 0 when cost is known zero (noUsage)", async () => {
    await withTemporaryDirectory(async (directory) => {
      const files = await openRunFiles(directory, run, redact);
      await files.writeResult({
        exitCode: 0,
        result: agentResult,
        finishedAt: "2026-11-12T00:00:00.000Z",
        costUsd: 0,
      });
      await files.close();

      const resultJson = JSON.parse(await Bun.file(join(directory, "result.json")).text());
      expect(resultJson.schemaVersion).toBe(2);
      expect(resultJson.costUsd).toBe(0);
    });
  });
});
