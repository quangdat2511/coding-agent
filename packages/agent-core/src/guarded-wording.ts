import type { UserMessage } from "@coding-agent/ai";
import { messageOf } from "./guards.ts";
import type { AgentResult } from "./result.ts";
import type { NormalizedToolCall } from "./state.ts";
import type { ToolCallClosing, TranscriptWording } from "./transcript-wording.ts";

export interface GuardedWording {
  closingContent(call: NormalizedToolCall, closing: ToolCallClosing): string;
  outcomeNote(result: AgentResult): UserMessage | undefined;
  readonly failure: string | undefined;
}

const isString = (value: unknown): value is string => typeof value === "string";

const isNoteText = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === "string" && value !== "");

// A failing wording never changes how a run ends; its first failure is kept for run_settled.
export function guardWording(wording: TranscriptWording): GuardedWording {
  let failure: string | undefined;

  function ask<T>(
    name: keyof TranscriptWording,
    word: () => unknown,
    accepts: (value: unknown) => value is T,
    expected: string,
  ): T | undefined {
    try {
      const value = word();
      if (accepts(value)) return value;
      failure ??= `TranscriptWording.${name} must return ${expected}`;
    } catch (error) {
      failure ??= `TranscriptWording.${name} threw: ${messageOf(error)}`;
    }
    return undefined;
  }

  return {
    closingContent: (call, closing) =>
      ask(
        "closingToolResult",
        () => wording.closingToolResult(structuredClone(call), closing),
        isString,
        "a string",
      ) ?? "",
    outcomeNote(result) {
      const text = ask(
        "outcomeNote",
        () => wording.outcomeNote(structuredClone(result)),
        isNoteText,
        "a non-empty string or undefined",
      );
      return text === undefined ? undefined : { role: "user", content: text };
    },
    get failure() {
      return failure;
    },
  };
}
