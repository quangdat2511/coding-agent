import { describe, expect, it } from "bun:test";
import type { Message, UserMessage } from "@coding-agent/ai";
import type { AgentRun, RunEvent } from "../src/index.ts";
import {
  collect,
  continueWith,
  fakeTool,
  fakeWriteTool,
  openTestRun,
  textMessage,
  textTurn,
  throwingTool,
  toolCallMessage,
  toolCallTurn,
  toolResultMessage,
  waitForEvent,
} from "./kit/index.ts";

const task = { objective: "Now add a test for sum" };
const taskMessage: UserMessage = { role: "user", content: task.objective };

const carried = (): Message[] => [
  { role: "user", content: "Add a sum function" },
  toolCallMessage({ toolCallId: "call-0", name: "echo", input: {} }),
  toolResultMessage("call-0", "ok", false),
  textMessage("Added sum."),
];

function appendedMessages(events: readonly RunEvent[]): Message[] {
  const providerIds = new Map<string, string | undefined>();
  return events.flatMap((event): Message[] => {
    switch (event.type) {
      case "run_started":
        return [{ role: "user", content: event.data.task.objective }];
      case "assistant_message_completed":
        return event.data.outcome === "completed" ? [event.data.message] : [];
      case "tool_call_queued":
        providerIds.set(event.data.toolCall.id, event.data.toolCall.providerId);
        return [];
      case "tool_call_completed": {
        const { content, isError } = event.data.result;
        const toolCallId = providerIds.get(event.data.toolCallId) ?? "";
        return [{ role: "user", content: [{ type: "tool_result", toolCallId, content, isError }] }];
      }
      case "verification_completed":
        return event.data.feedback === undefined ? [] : [event.data.feedback];
      case "run_settled":
        return event.data.outcomeNote === undefined ? [] : [event.data.outcomeNote];
      default:
        return [];
    }
  });
}

describe("starting from a carried Transcript", () => {
  it("sends the carried Transcript before the Coding Task and counts it as carried", async () => {
    const { run, model } = openTestRun({
      transcript: carried(),
      model: { turns: [textTurn("Added the test.")] },
    });

    expect(run.snapshot()).toMatchObject({
      phase: "ready",
      carriedMessages: 4,
      transcript: carried(),
    });
    await run.dispatch({ type: "start", task });
    await run.result();
    const events = await collect(run.events());

    expect(events[0]).toMatchObject({
      type: "run_started",
      data: { task, carriedMessages: 4 },
    });
    expect(model.requests[0]?.context.messages).toEqual([...carried(), taskMessage]);
    expect(run.snapshot().transcript).toEqual([
      ...carried(),
      taskMessage,
      textMessage("Added the test."),
    ]);
  });

  it("keeps its own copy, so a later change to the caller's Transcript changes nothing", async () => {
    const transcript = carried();
    const { run, model } = openTestRun({ transcript, model: { turns: [textTurn("Done.")] } });

    transcript.push({ role: "user", content: "an edit made after open" });
    (transcript[0] as UserMessage).content = "rewritten";
    await run.dispatch({ type: "start", task });
    await run.result();

    expect(model.requests[0]?.context.messages.slice(0, 4)).toEqual(carried());
    expect(run.snapshot().transcript.slice(0, 4)).toEqual(carried());
  });
});

describe("carrying each appended message on one Run Event", () => {
  const scenarios: { name: string; play: () => Promise<AgentRun> }[] = [
    {
      name: "a run that calls tools, is sent back by Verification and succeeds",
      async play() {
        const { run } = openTestRun({
          transcript: carried(),
          tools: [fakeTool(), throwingTool()],
          model: {
            turns: [
              toolCallTurn(
                { toolCallId: "call-1", name: "echo", input: {} },
                { toolCallId: "call-2", name: "explode", input: {} },
              ),
              textTurn("Done."),
              textTurn("Done, with the test."),
            ],
          },
          verification: [continueWith("Add the missing test.")],
        });
        await run.dispatch({ type: "start", task });
        await run.result();
        return run;
      },
    },
    {
      name: "a run cancelled while an Approval is pending",
      async play() {
        const { run } = openTestRun({
          tools: [fakeWriteTool()],
          model: {
            turns: [
              toolCallTurn(
                { toolCallId: "call-1", name: "write", input: { path: "a.ts" } },
                { toolCallId: "call-2", name: "write", input: { path: "b.ts" } },
              ),
            ],
          },
        });
        await run.dispatch({ type: "start", task });
        await waitForEvent(run, "approval_requested");
        await run.dispatch({ type: "cancel" });
        await run.result();
        return run;
      },
    },
    {
      name: "a run that reaches its Tool Call limit",
      async play() {
        const { run } = openTestRun({
          model: {
            turns: [
              toolCallTurn(
                { toolCallId: "call-1", name: "echo", input: {} },
                { toolCallId: "call-2", name: "echo", input: {} },
              ),
            ],
          },
          limits: { maxToolCalls: 1 },
        });
        await run.dispatch({ type: "start", task });
        await run.result();
        return run;
      },
    },
  ];

  it.each(scenarios)("$name", async ({ play }) => {
    const run = await play();
    const { transcript, carriedMessages } = run.snapshot();

    expect(transcript.slice(carriedMessages)).toEqual(
      appendedMessages(await collect(run.events())),
    );
  });
});
