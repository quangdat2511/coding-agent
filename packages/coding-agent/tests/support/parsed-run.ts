// Arguments of `coding-agent run` that parse, so cli.ts reaches its startup hardening. Without a
// task.md in the working directory, a run that gets past the hardening stops with a configuration
// error.
export const parsedRun = [
  "run",
  "--task-file",
  "task.md",
  "--provider",
  "anthropic",
  "--model",
  "claude-haiku-4-5",
  "--approval-policy",
  "auto-approve",
  "--output-dir",
  "out",
];
