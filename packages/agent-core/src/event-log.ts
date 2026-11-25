import type { RunEvent } from "./events.ts";

export interface EventLog {
  readonly lastSequence: number;
  append(event: RunEvent): void;
  close(): void;
  follow(afterSequence: number): AsyncIterable<RunEvent>;
  events(afterSequence?: number): readonly RunEvent[];
}

export function createEventLog(): EventLog {
  const events: RunEvent[] = [];
  let closed = false;
  let changed = Promise.withResolvers<void>();

  const notify = () => {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  };

  return {
    get lastSequence() {
      return events.length;
    },
    append(event) {
      events.push(event);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async *follow(afterSequence) {
      for (let next = afterSequence; ; ) {
        const event = events[next];
        if (event) {
          next += 1;
          yield event;
        } else if (closed) {
          return;
        } else {
          await changed.promise;
        }
      }
    },
    events(afterSequence = 0) {
      return events.slice(afterSequence);
    },
  };
}
