import type { AssistantMessageEvent } from "@/types";

export async function collectDoneEvent(
  eventStream: AsyncIterable<AssistantMessageEvent>,
): Promise<Extract<AssistantMessageEvent, { type: "done" }>> {
  for await (const event of eventStream) {
    if (event.type === "done") {
      return event;
    }
  }
  throw new Error("Stream completed without a 'done' event");
}
