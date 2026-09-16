import type { ModelStreamEvent } from "@/types";

export async function collectTurnEndEvent(
  eventStream: AsyncIterable<ModelStreamEvent>,
): Promise<Extract<ModelStreamEvent, { type: "turn_end" }>> {
  for await (const event of eventStream) {
    if (event.type === "turn_end") {
      return event;
    }
  }
  throw new Error("Stream completed without a 'turn_end' event");
}
