import type { Message } from "@/types";

export function flattenMessageContent(msg: Message): string {
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (msg.content.some((c) => c.type !== "text")) {
      throw new Error("tool_call/tool_result content is not supported by this adapter yet");
    }
    return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  }

  if (msg.content.some((c) => c.type !== "text")) {
    throw new Error("tool_call/tool_result content is not supported by this adapter yet");
  }
  return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}
