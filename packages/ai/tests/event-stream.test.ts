import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@/types";
import { createModelEventStream, EventStream } from "@/utils/event-stream";

describe("EventStream", () => {
  it("should yield events as they are pushed", async () => {
    const stream = new EventStream<number, number>(
      (event) => event === 3,
      (event) => event * 10,
    );

    const results: number[] = [];
    const pullTask = (async () => {
      for await (const event of stream) {
        results.push(event);
      }
    })();

    stream.push(1);
    stream.push(2);
    stream.push(3);

    await pullTask;

    expect(results).toEqual([1, 2, 3]);
    const finalResult = await stream.result();
    expect(finalResult).toBe(30);
  });

  it("should buffer events if pulled later", async () => {
    const stream = new EventStream<string, string>(
      (event) => event === "done",
      (event) => event.toUpperCase(),
    );

    stream.push("a");
    stream.push("b");
    stream.push("done");

    const results: string[] = [];
    for await (const event of stream) {
      results.push(event);
    }

    expect(results).toEqual(["a", "b", "done"]);
    expect(await stream.result()).toBe("DONE");
  });

  it("should handle manual end", async () => {
    const stream = new EventStream<string, string>(
      (event) => event === "done",
      (event) => event,
    );

    stream.push("a");
    stream.end("MANUAL_RESULT");
    stream.push("b"); // Should be ignored since stream is done

    const results: string[] = [];
    for await (const event of stream) {
      results.push(event);
    }

    expect(results).toEqual(["a"]);
    expect(await stream.result()).toBe("MANUAL_RESULT");
  });
});

describe("ModelEventStream", () => {
  it("should extract final result on 'turn_end' event", async () => {
    const stream = createModelEventStream();

    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      model: "test-model",
      finishReason: { reason: "end_turn", rawReason: "stop" },
    };

    const pullTask = (async () => {
      for await (const _ of stream) {
        // Just consume
      }
    })();

    stream.push({ type: "stream_start" });
    stream.push({
      type: "content_block_start",
      index: 0,
      block: { type: "text", text: "" },
    });
    stream.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello" },
    });
    stream.push({ type: "content_block_stop", index: 0 });
    stream.push({ type: "turn_end", message: finalMessage });

    await pullTask;

    const result = await stream.result();
    expect(result).toBe(finalMessage);
  });

  it("should reject result on 'error' event", async () => {
    const stream = createModelEventStream();

    stream.push({ type: "error", error: { message: "Something went wrong" } });

    // Consume stream
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", error: { message: "Something went wrong" } }]);
    expect(stream.result()).rejects.toThrow("Something went wrong");
  });

  it("should not cause unhandled rejection if consumed without calling result()", async () => {
    const stream = createModelEventStream();
    stream.push({ type: "error", error: { message: "Silent error" } });

    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0]?.type).toBe("error");
    // Ensure waiting a tick does not trigger an unhandled rejection
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
