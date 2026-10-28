import {
  type AgentSession,
  openAgentSession,
  type SessionEvent,
  type ToolResult,
} from "../../src/index.ts";
import { createTestKit, type TestKit, type TestKitOptions } from "./test-kit.ts";

export interface TestSession extends TestKit {
  readonly session: AgentSession;
}

export function openTestSession(options: TestKitOptions = {}): TestSession {
  const kit = createTestKit(options);
  const opened = openAgentSession(kit.config);
  if (!opened.ok) throw new Error(`expected a session, got: ${opened.message}`);
  return { ...kit, session: opened.session };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

export const resultOf = (
  events: readonly SessionEvent[],
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

export async function waitForEvent<T extends SessionEvent["type"]>(
  session: AgentSession,
  type: T,
  afterSequence = 0,
): Promise<Extract<SessionEvent, { type: T }>> {
  for await (const event of session.events(afterSequence)) {
    if (event.type === type) return event as Extract<SessionEvent, { type: T }>;
  }
  throw new Error(`event ${type} was never emitted before the session settled`);
}
