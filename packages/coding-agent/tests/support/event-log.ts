import { join } from "node:path";

export interface LoggedEvent {
  readonly schemaVersion: number;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

// A line still being written has no newline yet, so only the lines before the last one count.
export async function loggedEvents(outputDir: string): Promise<LoggedEvent[]> {
  const log = Bun.file(join(outputDir, "events.jsonl"));
  const lines = (await log.exists()) ? (await log.text()).split("\n").slice(0, -1) : [];
  return lines.map((line) => JSON.parse(line));
}

export const verificationsOf = async (outputDir: string): Promise<LoggedEvent[]> =>
  (await loggedEvents(outputDir)).filter(({ type }) => type === "verification_completed");
