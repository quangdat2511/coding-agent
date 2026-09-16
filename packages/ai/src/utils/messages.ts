import type { Message } from "@/types";

export function flattenMessageContent(msg: Message): string {
  if (msg.role === "user") {
    return typeof msg.content === "string"
      ? msg.content
      : msg.content.map((c) => (c.type === "text" ? c.text : c.content)).join("");
  }
  return msg.content.map((c) => (c.type === "text" ? c.text : c.arguments)).join("");
}
