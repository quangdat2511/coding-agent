import { describe, expect, it } from "bun:test";
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  GOOGLE_GENERATE_CONTENT_CAPABILITIES,
  OPENAI_CHAT_COMPLETIONS_CAPABILITIES,
  OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
  withModelOverrides,
  XAI_CHAT_COMPLETIONS_CAPABILITIES,
} from "@/capabilities";
import type { ModelCapabilities } from "@/types";

describe("Model Capabilities Constants", () => {
  const allCapConstants: { name: string; caps: ModelCapabilities }[] = [
    { name: "ANTHROPIC_MESSAGES_CAPABILITIES", caps: ANTHROPIC_MESSAGES_CAPABILITIES },
    { name: "OPENAI_CHAT_COMPLETIONS_CAPABILITIES", caps: OPENAI_CHAT_COMPLETIONS_CAPABILITIES },
    { name: "GOOGLE_GENERATE_CONTENT_CAPABILITIES", caps: GOOGLE_GENERATE_CONTENT_CAPABILITIES },
    {
      name: "OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES",
      caps: OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES,
    },
    { name: "XAI_CHAT_COMPLETIONS_CAPABILITIES", caps: XAI_CHAT_COMPLETIONS_CAPABILITIES },
  ];

  for (const { name, caps } of allCapConstants) {
    it(`${name} has all five required ModelCapabilities fields`, () => {
      expect(typeof caps.parallelToolCallControl).toBe("boolean");
      expect(["client_abort_only", "native_in_flight"]).toContain(caps.cancellation);
      expect(["streamed", "whole"]).toContain(caps.toolArgumentDelivery);
      expect(["incremental", "final"]).toContain(caps.usageTiming);
      expect(typeof caps.serverSideTools).toBe("boolean");
    });
  }

  it("Anthropic Messages: streams arguments, client-abort, parallel control, final usage, no server tools", () => {
    expect(ANTHROPIC_MESSAGES_CAPABILITIES).toEqual({
      parallelToolCallControl: true,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "streamed",
      usageTiming: "final",
      serverSideTools: false,
    });
  });

  it("OpenAI Chat Completions: streams arguments, client-abort, parallel control, final usage, no server tools", () => {
    expect(OPENAI_CHAT_COMPLETIONS_CAPABILITIES).toEqual({
      parallelToolCallControl: true,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "streamed",
      usageTiming: "final",
      serverSideTools: false,
    });
  });

  it("Google generateContent: whole arguments, client-abort, no parallel control, final usage, has server tools", () => {
    expect(GOOGLE_GENERATE_CONTENT_CAPABILITIES).toEqual({
      parallelToolCallControl: false,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "whole",
      usageTiming: "final",
      serverSideTools: true,
    });
  });

  it("OpenRouter Chat Completions: streams arguments, client-abort, parallel control, final usage, no server tools", () => {
    expect(OPENROUTER_CHAT_COMPLETIONS_CAPABILITIES).toEqual({
      parallelToolCallControl: true,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "streamed",
      usageTiming: "final",
      serverSideTools: false,
    });
  });

  it("xAI Chat Completions: whole arguments, client-abort, parallel control, final usage, no server tools", () => {
    expect(XAI_CHAT_COMPLETIONS_CAPABILITIES).toEqual({
      parallelToolCallControl: true,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "whole",
      usageTiming: "final",
      serverSideTools: false,
    });
  });
});

describe("withModelOverrides", () => {
  it("returns a new object with overridden fields changed", () => {
    const result = withModelOverrides(OPENAI_CHAT_COMPLETIONS_CAPABILITIES, {
      toolArgumentDelivery: "whole",
      serverSideTools: true,
    });

    expect(result.toolArgumentDelivery).toBe("whole");
    expect(result.serverSideTools).toBe(true);
    // unchanged fields preserved
    expect(result.parallelToolCallControl).toBe(true);
    expect(result.cancellation).toBe("client_abort_only");
    expect(result.usageTiming).toBe("final");
  });

  it("returns an object equal to default when overrides is empty", () => {
    const result = withModelOverrides(ANTHROPIC_MESSAGES_CAPABILITIES, {});
    expect(result).toEqual(ANTHROPIC_MESSAGES_CAPABILITIES);
  });

  it("does not mutate the original capabilities constant", () => {
    const original = { ...OPENAI_CHAT_COMPLETIONS_CAPABILITIES };
    withModelOverrides(OPENAI_CHAT_COMPLETIONS_CAPABILITIES, {
      toolArgumentDelivery: "whole",
    });
    expect(OPENAI_CHAT_COMPLETIONS_CAPABILITIES).toEqual(original);
  });
});
