import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@/types";
import { createAssistantMessageEventStream, EventStream } from "@/utils/event-stream";

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

describe("AssistantMessageEventStream", () => {
  it("should extract final result on 'done' event", async () => {
    const stream = createAssistantMessageEventStream();

    const finalMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      model: "test-model",
      stopReason: "stop",
    };

    const pullTask = (async () => {
      for await (const _ of stream) {
        // Just consume
      }
    })();

    stream.push({ type: "start", partial: finalMessage });
    stream.push({ type: "text_delta", delta: "Hello", partial: finalMessage });
    stream.push({ type: "done", reason: "stop", message: finalMessage });

    await pullTask;

    const result = await stream.result();
    expect(result).toBe(finalMessage);
  });

  it("should extract error on 'error' event", async () => {
    const stream = createAssistantMessageEventStream();

    const errMessage: AssistantMessage = {
      role: "assistant",
      content: [],
      model: "test-model",
      stopReason: "error",
      errorMessage: "Something went wrong",
    };

    stream.push({ type: "error", reason: "error", error: errMessage });

    // Consume stream
    for await (const _ of stream) {
    }

    const result = await stream.result();
    expect(result).toBe(errMessage);
  });
});
