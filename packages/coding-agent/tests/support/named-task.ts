import { join } from "node:path";

const namedTask = join(import.meta.dir, "..", "fixtures", "named-task");

export const NAMED_TASK_FILE = join(namedTask, "task.md");

// A test copies this directory into a temporary one and never runs the agent on it in place.
export const NAMED_TASK_REPO = join(namedTask, "repo");

// One live run with read as the only tool: the model reads src/slugify.ts, tries
// src/slugify.test.ts, which does not exist, and then answers.
export const READ_ONLY_RUN = {
  provider: "google",
  model: "gemini-3.5-flash-lite",
  fixtures: [1, 2, 3].map((turn) => `google/named-task-read-only/turn-${turn}.txt`),
} as const;
