import { describe, expect, it } from "bun:test";
import {
  ANTHROPIC_MESSAGES_CAPABILITIES,
  applyCapabilities,
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

    it(`${name} is frozen at runtime (Object.isFrozen)`, () => {
      expect(Object.isFrozen(caps)).toBe(true);
    });
  }

  it("Anthropic Messages: streams arguments, client-abort, parallel control, incremental usage, no server tools", () => {
    expect(ANTHROPIC_MESSAGES_CAPABILITIES).toEqual({
      parallelToolCallControl: true,
      cancellation: "client_abort_only",
      toolArgumentDelivery: "streamed",
      usageTiming: "incremental",
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

  it("returns a frozen object at runtime", () => {
    const result = withModelOverrides(OPENAI_CHAT_COMPLETIONS_CAPABILITIES, {
      toolArgumentDelivery: "whole",
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("does not overwrite default capability when override property is undefined", () => {
    const result = withModelOverrides(OPENAI_CHAT_COMPLETIONS_CAPABILITIES, {
      parallelToolCallControl: undefined,
    });
    expect(result.parallelToolCallControl).toBe(true);
  });
});

describe("applyCapabilities", () => {
  const rawModels = [
    { id: "model-a", name: "Model A", provider: "test" },
    { id: "model-b", name: "Model B", provider: "test" },
  ];

  it("applies default capabilities to all models when no overrides given", () => {
    const models = applyCapabilities(rawModels, OPENAI_CHAT_COMPLETIONS_CAPABILITIES);
    expect(models).toHaveLength(2);
    expect(models[0]?.capabilities).toEqual(OPENAI_CHAT_COMPLETIONS_CAPABILITIES);
    expect(models[1]?.capabilities).toEqual(OPENAI_CHAT_COMPLETIONS_CAPABILITIES);
  });

  it("applies per-model overrides only to the specified model id", () => {
    const models = applyCapabilities(rawModels, OPENAI_CHAT_COMPLETIONS_CAPABILITIES, {
      "model-b": { toolArgumentDelivery: "whole", serverSideTools: true },
    });

    expect(models[0]?.capabilities).toEqual(OPENAI_CHAT_COMPLETIONS_CAPABILITIES);
    expect(models[1]?.capabilities?.toolArgumentDelivery).toBe("whole");
    expect(models[1]?.capabilities?.serverSideTools).toBe(true);
    expect(models[1]?.capabilities?.parallelToolCallControl).toBe(true);
  });

  it("does not mutate original raw models", () => {
    applyCapabilities(rawModels, OPENAI_CHAT_COMPLETIONS_CAPABILITIES);
    expect((rawModels[0] as { capabilities?: unknown } | undefined)?.capabilities).toBeUndefined();
  });
});
