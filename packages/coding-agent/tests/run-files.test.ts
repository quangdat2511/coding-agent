import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { RunEvent } from "@coding-agent/agent-core";
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
      '{"schemaVersion":1,"runId":"run-1","sequence":1,' +
        '"occurredAt":"2026-11-12T00:00:00.000Z","type":"tool_execution_started",' +
        '"data":{"toolCallId":"call-1","mutation":"read_only"}}',
      '{"schemaVersion":1,"runId":"run-1","sequence":5,' +
        '"occurredAt":"2026-11-12T00:00:00.000Z","type":"verification_started",' +
        '"data":{"verificationId":"v"}}',
    ]);
  });

  it("writes the credential neither as a value nor as a property name", async () => {
    const text = await logged([
      event(1, "tool_call_completed", {
        toolCallId: "call-1",
        outcome: "failed",
        result: { details: { [secret]: [`key ${secret}`], nested: { [`x-${secret}`]: 1 } } },
      }),
    ]);

    expect(text).not.toContain(secret);
    expect(JSON.parse(text).data.result.details).toEqual({
      "[redacted]": ["key [redacted]"],
      nested: { "x-[redacted]": 1 },
    });
  });
});
