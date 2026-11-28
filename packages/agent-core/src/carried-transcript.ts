import type { Message, TextBlock, ToolResultBlock } from "@coding-agent/ai";
import type { ConfigProblem } from "./config-validation.ts";
import { isNonEmptyString, isRecord, messageOf } from "./guards.ts";
import { isUsableMessage } from "./model-response.ts";

const problemAt = (field: string, detail: string): ConfigProblem => ({
  field,
  message: `${field} ${detail}`,
});

const isUserBlock = (block: unknown): block is TextBlock | ToolResultBlock =>
  isRecord(block) &&
  ((block.type === "text" && typeof block.text === "string") ||
    (block.type === "tool_result" &&
      isNonEmptyString(block.toolCallId) &&
      typeof block.content === "string" &&
      typeof block.isError === "boolean"));

// No stricter than what a run appends itself, so a Transcript that a run wrote is never refused.
export function findTranscriptProblem(transcript: unknown): ConfigProblem | undefined {
  if (transcript === undefined) return undefined;
  if (!Array.isArray(transcript)) return problemAt("transcript", "must be a list of messages");

  const open = new Map<string, string>();
  const answered = new Set<string>();
  for (const [index, message] of transcript.entries()) {
    const field = `transcript[${index}]`;
    if (isRecord(message) && message.role === "assistant") {
      if (!isUsableMessage(message)) return problemAt(field, "is not a usable assistant message");
      for (const [blockIndex, block] of message.content.entries()) {
        if (block.type !== "tool_call") continue;
        const blockField = `${field}.content[${blockIndex}]`;
        if (open.has(block.toolCallId)) {
          return problemAt(blockField, `repeats the unanswered tool_call id "${block.toolCallId}"`);
        }
        open.set(block.toolCallId, blockField);
      }
      continue;
    }
    if (!isRecord(message) || message.role !== "user") {
      return problemAt(field, "must be a user or an assistant message");
    }
    const { content } = message;
    if (typeof content === "string") continue;
    if (!Array.isArray(content)) {
      return problemAt(`${field}.content`, "must be text or a list of text and tool_result blocks");
    }
    for (const [blockIndex, block] of content.entries()) {
      const blockField = `${field}.content[${blockIndex}]`;
      if (!isUserBlock(block)) {
        return problemAt(blockField, "must be a text or a tool_result block");
      }
      if (block.type !== "tool_result") continue;
      const id = block.toolCallId;
      if (open.delete(id)) {
        answered.add(id);
      } else if (answered.has(id)) {
        return problemAt(blockField, `answers the tool_call "${id}" a second time`);
      } else {
        return problemAt(blockField, `answers no earlier tool_call: "${id}"`);
      }
    }
  }

  for (const [id, field] of open) {
    return problemAt(field, `is a tool_call that no tool_result answers: "${id}"`);
  }
  return undefined;
}

export function copyTranscript(transcript: readonly Message[] = []): Message[] | ConfigProblem {
  try {
    return structuredClone([...transcript]);
  } catch (error) {
    return problemAt("transcript", `must be plain data: ${messageOf(error)}`);
  }
}
