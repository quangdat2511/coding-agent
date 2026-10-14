import { type AgentSession, openAgentSession } from "../../src/index.ts";
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
