import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model, TextBlock } from "@coding-agent/ai";
import type { VerificationEvidence } from "../src/index.ts";
import { collect, openTestSession, textMessage, textTurn, throwingRequest } from "./kit/index.ts";

const task = { objective: "Fix the failing test" };

const objective = { role: "user", content: "Fix the failing test" } as const;

const tamper = (message: AssistantMessage | undefined) => {
  const block = message?.content[0] as TextBlock | undefined;
  if (block) block.text = "tampered";
};

describe("isolating the Agent Session from its ports", () => {
  it("keeps the committed message when the model later mutates its own copy", async () => {
    const answer = textMessage("Fixed it.");
    const { session } = openTestSession({
      model: { turns: [[{ type: "stream_start" }, { type: "turn_end", message: answer }]] },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    tamper(answer);

    expect(result).toMatchObject({ finalMessage: textMessage("Fixed it.") });
    expect(session.snapshot().transcript).toEqual([objective, textMessage("Fixed it.")]);
  });

  it("keeps the transcript when the model mutates the context it was sent", async () => {
    const { session, model } = openTestSession({ model: { turns: [textTurn("Fixed it.")] } });

    await session.dispatch({ type: "start", task });
    await session.result();
    const sent = model.requests[0]?.context.messages;
    sent?.push(textMessage("Fixed it."));
    if (sent?.[0]) sent[0].content = "tampered";

    expect(session.snapshot().transcript).toEqual([objective, textMessage("Fixed it.")]);
  });

  it("keeps the transcript when the Verification Policy mutates the candidate", async () => {
    const { session } = openTestSession({
      model: { turns: [textTurn("Fixed it.")] },
      verification: [
        async (candidate) => {
          tamper(candidate.finalMessage);
          tamper(candidate.transcript[1] as AssistantMessage);
          return { outcome: "succeeded", evidence: [] };
        },
      ],
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();

    expect(result).toMatchObject({ finalMessage: textMessage("Fixed it.") });
    expect(session.snapshot().transcript).toEqual([objective, textMessage("Fixed it.")]);
  });

  it("keeps the published evidence and feedback when the policy later mutates them", async () => {
    const evidence: VerificationEvidence[] = [
      { type: "no_command_configured", workspaceChanged: false },
    ];
    const feedback = { role: "user" as const, content: "[Verification Failed]" };
    const { session } = openTestSession({
      model: { turns: [textTurn("Fixed it."), textTurn("Fixed it properly.")] },
      verification: [
        { outcome: "continue", evidence, feedback },
        { outcome: "succeeded", evidence },
      ],
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    evidence.push({ type: "no_command_configured", workspaceChanged: true });
    feedback.content = "tampered";

    expect(result.verification?.evidence).toEqual([
      { type: "no_command_configured", workspaceChanged: false },
    ]);
    expect(session.snapshot().transcript[2]).toEqual({
      role: "user",
      content: "[Verification Failed]",
    });
  });

  it("keeps the model identity it published when the caller later mutates it", async () => {
    const identity: Model = { id: "fake-model", name: "Fake Model", provider: "fake" };
    const { session } = openTestSession({ model: { identity, turns: [textTurn("Fixed it.")] } });

    await session.dispatch({ type: "start", task });
    await session.result();
    identity.name = "tampered";

    const events = await collect(session.events());
    expect(events.find((event) => event.type === "model_turn_started")?.data).toMatchObject({
      model: { id: "fake-model", name: "Fake Model", provider: "fake" },
    });
  });

  it("publishes only plain data, never a raw Error, when its ports throw", async () => {
    const { session } = openTestSession({
      model: { turns: [throwingRequest(new TypeError("fetch failed"))] },
    });

    await session.dispatch({ type: "start", task });
    const result = await session.result();
    const events = await collect(session.events());

    expect(JSON.parse(JSON.stringify(events))).toStrictEqual(events);
    expect(JSON.parse(JSON.stringify(session.snapshot()))).toStrictEqual(session.snapshot());
    expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
  });
});
