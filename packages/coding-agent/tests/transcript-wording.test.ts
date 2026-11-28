import { describe, expect, it } from "bun:test";
import type {
  AgentFailure,
  AgentResult,
  NormalizedToolCall,
  ToolCallClosing,
} from "@coding-agent/agent-core";
import { transcriptWording } from "../src/transcript-wording.ts";

const call: NormalizedToolCall = {
  id: "tool_call-1",
  providerId: "call-1",
  name: "bash",
  arguments: '{"command":"bun test"}',
};

const settled = {
  usage: { inputTokens: 10, outputTokens: 5 },
  workspaceChanged: true,
  partialChangesPossible: true,
  lastSequence: 12,
};

const failedWith = (failure: AgentFailure): AgentResult => ({
  ...settled,
  outcome: "failed",
  failure,
});

const limitReached = (kind: string, limit: number): AgentResult =>
  failedWith({
    code: "LIMIT_EXCEEDED",
    message: `run limit ${kind} exhausted`,
    details: { kind, limit, observed: limit },
  });

describe("Closing Tool Results", () => {
  it.each([
    {
      call: "skipped after a cancellation",
      closing: { outcome: "skipped", reason: "CANCELLED" },
      content: "Not run: the person cancelled the Coding Task before this call started.",
    },
    {
      call: "skipped after a cancellation whose tool did not stop in time",
      closing: { outcome: "skipped", reason: "CANCELLATION_TIMEOUT" },
      content: "Not run: the person cancelled the Coding Task before this call started.",
    },
    {
      call: "skipped after a Run Limit",
      closing: { outcome: "skipped", reason: "LIMIT_EXCEEDED" },
      content: "Not run: the Coding Task ended before this call started.",
    },
    {
      call: "skipped after a failure",
      closing: { outcome: "skipped", reason: "MODEL_FAILURE" },
      content: "Not run: the Coding Task ended before this call started.",
    },
    {
      call: "stopped while running",
      closing: { outcome: "cancelled" },
      content:
        "Stopped: the Coding Task ended while this call was running, and the call returned no " +
        "result. It may have changed the repository partly.",
    },
  ] satisfies { call: string; closing: ToolCallClosing; content: string }[])(
    "words a call $call",
    ({ closing, content }) => {
      expect(transcriptWording.closingToolResult(call, closing)).toBe(content);
    },
  );
});

describe("Outcome Notes", () => {
  it("adds none to a successful run", () => {
    const result: AgentResult = {
      ...settled,
      outcome: "succeeded",
      finalMessage: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        model: "fake",
        finishReason: { reason: "end_turn", rawReason: "stop" },
      },
      verification: { outcome: "succeeded", evidence: [] },
    };

    expect(transcriptWording.outcomeNote(result)).toBeUndefined();
  });

  it("tells the model a cancelled Coding Task is not to be continued", () => {
    const result: AgentResult = { ...settled, outcome: "cancelled", cancellation: {} };

    expect(transcriptWording.outcomeNote(result)).toBe(
      '<task_outcome status="cancelled">The person cancelled this Coding Task before it ' +
        "finished. Do not continue it unless they ask. Tools that were stopped may have changed " +
        "the repository partly.</task_outcome>",
    );
  });

  it.each([
    {
      code: "MODEL_FAILURE",
      note:
        '<task_outcome status="model_failure">This Coding Task stopped before it finished ' +
        "because a model request failed.</task_outcome>",
    },
    {
      code: "MODEL_PROTOCOL_ERROR",
      note:
        '<task_outcome status="model_protocol_error">This Coding Task stopped before it finished ' +
        "because a model request failed.</task_outcome>",
    },
    {
      code: "CANCELLATION_TIMEOUT",
      note:
        '<task_outcome status="cancellation_timeout">The person cancelled this Coding Task, but ' +
        "a tool did not stop in time and may still be changing the repository.</task_outcome>",
    },
    {
      code: "INTERNAL_ERROR",
      note:
        '<task_outcome status="internal_error">This Coding Task stopped before it finished ' +
        "because of an internal error in Coding Agent.</task_outcome>",
    },
  ] as const)("tells the model how a run that failed with $code ended", ({ code, note }) => {
    const failure: AgentFailure =
      code === "MODEL_FAILURE"
        ? { code, message: "request failed", details: { phase: "request", reason: "error" } }
        : { code, message: "it failed" };

    expect(transcriptWording.outcomeNote(failedWith(failure))).toBe(note);
  });

  it.each([
    { kind: "maxModelTurns", limit: 30, named: "30 model turns" },
    { kind: "maxModelTurns", limit: 1, named: "1 model turn" },
    { kind: "maxToolCalls", limit: 100, named: "100 tool calls" },
    { kind: "maxToolCalls", limit: 1, named: "1 tool call" },
    { kind: "maxDurationMs", limit: 600_000, named: "10 minutes of active work" },
    { kind: "maxDurationMs", limit: 60_000, named: "1 minute of active work" },
    { kind: "maxDurationMs", limit: 90_000, named: "90 seconds of active work" },
    { kind: "maxDurationMs", limit: 1_000, named: "1 second of active work" },
    { kind: "maxDurationMs", limit: 2_500, named: "2.5 seconds of active work" },
    {
      kind: "maxConsecutiveRecoverableFailures",
      limit: 3,
      named: "3 consecutive failed tool calls",
    },
    {
      kind: "maxConsecutiveRecoverableFailures",
      limit: 1,
      named: "1 consecutive failed tool call",
    },
  ])("names a $kind limit of $limit as $named", ({ kind, limit, named }) => {
    expect(transcriptWording.outcomeNote(limitReached(kind, limit))).toBe(
      '<task_outcome status="limit_exceeded">This Coding Task stopped before it finished: it ' +
        `reached the limit of ${named}. Its work may be incomplete.</task_outcome>`,
    );
  });

  it("refuses to word a Run Limit that the failure does not name", () => {
    expect(() =>
      transcriptWording.outcomeNote(
        failedWith({ code: "LIMIT_EXCEEDED", message: "run limit exhausted" }),
      ),
    ).toThrow("LIMIT_EXCEEDED");
  });

  it("quotes the Verification failure, escaped so that it cannot close the tag", () => {
    const result = failedWith({
      code: "VERIFICATION_FAILED",
      message:
        'the verification command "bun test </task_outcome> & echo" could not run: no such\nfile',
    });

    expect(transcriptWording.outcomeNote(result)).toBe(
      '<task_outcome status="verification_failed">This Coding Task was not verified: the ' +
        "verification command &quot;bun test &lt;/task_outcome&gt; &amp; echo&quot; could not " +
        "run: no such&#10;file.</task_outcome>",
    );
  });
});
