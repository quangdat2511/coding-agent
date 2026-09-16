import type { ModelStreamEvent } from "@/stream";
import type { AssistantMessage } from "@/types";

export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;
  private rejectFinalResult!: (reason?: unknown) => void;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve, reject) => {
      this.resolveFinalResult = resolve;
      this.rejectFinalResult = reject;
    });
    // Prevent unhandled promise rejection if finalResultPromise rejects
    // but the consumer only consumes the stream via async iteration without calling .result()
    this.finalResultPromise.catch(() => {});
  }

  push(event: T): void {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
      try {
        this.resolveFinalResult(this.extractResult(event));
      } catch (err) {
        this.rejectFinalResult(err);
      }
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      if (waiter) {
        waiter({ value: undefined, done: true });
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) =>
          this.waiting.push(resolve),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

export class ModelEventStream extends EventStream<ModelStreamEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "turn_end" || event.type === "error",
      (event) => {
        if (event.type === "turn_end") {
          return event.message;
        }
        if (event.type === "error") {
          throw new Error(event.error.message);
        }
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}

export function createModelEventStream(): ModelEventStream {
  return new ModelEventStream();
}
