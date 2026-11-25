import { type AgentRun, openAgentRun, type RunEvent, type ToolResult } from "../../src/index.ts";
import { createTestKit, type TestKit, type TestKitOptions } from "./test-kit.ts";

export interface TestRun extends TestKit {
  readonly run: AgentRun;
}

export function openTestRun(options: TestKitOptions = {}): TestRun {
  const kit = createTestKit(options);
  const opened = openAgentRun(kit.config);
  if (!opened.ok) throw new Error(`expected a run, got: ${opened.message}`);
  return { ...kit, run: opened.run };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export const resultOf = (
  events: readonly RunEvent[],
  toolCallId: string,
): ToolResult | undefined => {
  for (const event of events) {
    if (
      event.type === "tool_call_completed" &&
      event.data.toolCallId === toolCallId &&
      event.data.outcome !== "skipped"
    ) {
      return event.data.result;
    }
  }
  return undefined;
};

export async function waitForEvent<T extends RunEvent["type"]>(
  run: AgentRun,
  type: T,
  afterSequence = 0,
): Promise<Extract<RunEvent, { type: T }>> {
  for await (const event of run.events(afterSequence)) {
    if (event.type === type) return event as Extract<RunEvent, { type: T }>;
  }
  throw new Error(`event ${type} was never emitted before the run settled`);
}
