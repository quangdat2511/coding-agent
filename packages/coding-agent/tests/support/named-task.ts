import { readdirSync } from "node:fs";
import { join } from "node:path";

const fixtures = join(import.meta.dir, "..", "fixtures");
const namedTask = join(fixtures, "named-task");

// Each turn-<n>.txt of a recording below tests/fixtures/, in turn order.
function recordedTurns(recording: string): string[] {
  const turns = readdirSync(join(fixtures, recording))
    .flatMap((name) => /^turn-(\d+)\.txt$/.exec(name)?.[1] ?? [])
    .map(Number)
    .sort((a, b) => a - b)
    .map((turn) => `${recording}/turn-${turn}.txt`);
  if (turns.length === 0) throw new Error(`tests/fixtures/${recording} holds no turn-<n>.txt`);
  return turns;
}

export const NAMED_TASK_FILE = join(namedTask, "task.md");

// A test copies this directory into a temporary one and never runs the agent on it in place.
export const NAMED_TASK_REPO = join(namedTask, "repo");

// One live run with the four tools and `bun test` as the verification command: the model adds the
// failing test, Verification fails it, and the model then fixes slugify.
export const NAMED_TASK_RUN = {
  provider: "google",
  model: "gemini-3.5-flash-lite",
  verificationCommand: "bun test",
  // Read on use, not on import: cli.test.ts and headless.test.ts import this file too.
  get fixtures() {
    return recordedTurns("google/named-task");
  },
} as const;

// One live run with read as the only tool: the model reads src/slugify.ts, tries
// src/slugify.test.ts, which does not exist, and then answers.
export const READ_ONLY_RUN = {
  provider: "google",
  model: "gemini-3.5-flash-lite",
  fixtures: [1, 2, 3].map((turn) => `google/named-task-read-only/turn-${turn}.txt`),
} as const;
