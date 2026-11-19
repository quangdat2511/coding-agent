import {
  type AgentSession,
  type ApprovalPolicy,
  type OpenSessionResult,
  openAgentSession,
} from "@coding-agent/agent-core";
import {
  type ChildProcessLauncher,
  createDefaultTools,
  createVerificationPolicy,
  createVerificationRunner,
  createWorkspaceResolver,
} from "@coding-agent/tools";
import { randomIds, systemClock } from "./clock-and-ids.ts";
import { createModelPort } from "./model-port.ts";
import type { RunConfig } from "./run-config.ts";
import { assembleSystemPrompt, type SkippedProjectInstructions } from "./system-prompt.ts";

export type SessionConfig = Pick<
  RunConfig,
  | "model"
  | "credential"
  | "sampling"
  | "transportRetryBound"
  | "givenRepoRoot"
  | "limits"
  | "verification"
> & { readonly approvalPolicy: ApprovalPolicy };

export type SessionFactoryResult =
  | {
      readonly ok: true;
      readonly session: AgentSession;
      readonly systemPrompt: string;
      readonly toolNames: readonly string[];
      readonly skippedInstructions: readonly SkippedProjectInstructions[];
    }
  | Extract<OpenSessionResult, { ok: false }>;

export async function openSession(
  config: SessionConfig,
  launcher: ChildProcessLauncher,
): Promise<SessionFactoryResult> {
  const workspace = await createWorkspaceResolver(config.givenRepoRoot);
  if (!workspace.ok) return workspace;
  const tools = createDefaultTools(launcher);
  const prompt = await assembleSystemPrompt({
    workspace: workspace.workspace,
    tools,
    platform: process.platform,
  });
  if (!prompt.ok) return prompt;
  const runner = createVerificationRunner({ launcher, workspace: workspace.workspace });
  if (!runner.ok) throw new Error(runner.message);
  const opened = openAgentSession({
    model: createModelPort(config),
    systemPrompt: prompt.systemPrompt,
    tools,
    workspace: workspace.workspace,
    approvalPolicy: config.approvalPolicy,
    verification: createVerificationPolicy({
      command: config.verification.command,
      runner: runner.runner,
    }),
    limits: config.limits,
    clock: systemClock,
    ids: randomIds,
  });
  if (!opened.ok) return opened;
  return {
    ...opened,
    systemPrompt: prompt.systemPrompt,
    toolNames: tools.list().map(({ name }) => name),
    skippedInstructions: prompt.skipped,
  };
}
