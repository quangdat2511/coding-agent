import {
  type AgentSession,
  type ApprovalPolicy,
  type Clock,
  type IdSource,
  type OpenSessionResult,
  openAgentSession,
  type ToolRegistry,
  type VerificationPolicy,
} from "@coding-agent/agent-core";
import { createWorkspaceResolver, readTool } from "@coding-agent/tools";
import { createModelPort } from "./model-port.ts";
import { type RunConfig, VERIFICATION_COMMAND_ENV_VAR } from "./run-config.ts";
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
      readonly skippedInstructions: readonly SkippedProjectInstructions[];
    }
  | Extract<OpenSessionResult, { ok: false }>
  | { readonly ok: false; readonly code: "NOT_IMPLEMENTED"; readonly message: string };

const systemClock: Clock = {
  now: () => new Date().toISOString(),
  monotonicMs: () => Math.floor(performance.now()),
};

const randomIds: IdSource = { next: (kind) => `${kind}-${crypto.randomUUID()}` };

// Temporary: the walking skeleton registers read only. CDA-80 (D5) registers all four tools.
function registeredTools(): ToolRegistry {
  const read = readTool();
  return { get: (name) => (name === read.name ? read : undefined), list: () => [read] };
}

// Temporary: CDA-80 (D5) replaces this stand-in with the Verification Policy of CDA-77 (B4.2).
const nonGatingVerification: VerificationPolicy = {
  verify: async ({ workspaceChanged }) => ({
    outcome: "succeeded",
    evidence: [{ type: "no_command_configured", workspaceChanged }],
  }),
};

export async function openSession(config: SessionConfig): Promise<SessionFactoryResult> {
  const workspace = await createWorkspaceResolver(config.givenRepoRoot);
  if (!workspace.ok) return workspace;
  const tools = registeredTools();
  const prompt = await assembleSystemPrompt({
    workspace: workspace.workspace,
    tools,
    platform: process.platform,
  });
  if (!prompt.ok) return prompt;
  // Temporary: the stand-in runs no command, and skipping one would report a check that never ran.
  if (config.verification.command !== null) {
    return {
      ok: false,
      code: "NOT_IMPLEMENTED",
      message:
        `${VERIFICATION_COMMAND_ENV_VAR} is set, but no verification command runs yet; ` +
        "CDA-80 (D5) wires in the Verification Policy",
    };
  }
  const opened = openAgentSession({
    model: createModelPort(config),
    systemPrompt: prompt.systemPrompt,
    tools,
    workspace: workspace.workspace,
    approvalPolicy: config.approvalPolicy,
    verification: nonGatingVerification,
    limits: config.limits,
    clock: systemClock,
    ids: randomIds,
  });
  return opened.ok ? { ...opened, skippedInstructions: prompt.skipped } : opened;
}
