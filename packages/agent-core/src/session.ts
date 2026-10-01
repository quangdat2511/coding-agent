import type { SessionEvent } from "@/events";
import type { ApprovalPolicy, Clock, IdSource, ModelPort, SessionLimits } from "@/ports";
import type { AgentResult } from "@/result";
import type { AgentState } from "@/state";
import type { CodingTask } from "@/task";
import type { ToolRegistry } from "@/tool";
import type { VerificationPolicy } from "@/verification";
import type { WorkspaceResolver } from "@/workspace";

export type SessionCommand =
  | { type: "start"; task: CodingTask }
  | {
      type: "resolve_approval";
      approvalId: string;
      decision: "allow" | "deny";
      reason?: string;
    }
  | { type: "cancel"; reason?: string };

export type CommandResult =
  | { accepted: true; sequence: number }
  | {
      accepted: false;
      code: "INVALID_STATE" | "ALREADY_STARTED" | "STALE_APPROVAL" | "ALREADY_SETTLED";
      message: string;
    };

export interface AgentSession {
  dispatch(command: SessionCommand): Promise<CommandResult>;
  snapshot(): AgentState;
  events(afterSequence?: number): AsyncIterable<SessionEvent>;
  result(): Promise<AgentResult>;
}

export interface OpenSessionConfig {
  model: ModelPort;
  systemPrompt: string;
  tools: ToolRegistry;
  workspace: WorkspaceResolver;
  approvalPolicy: ApprovalPolicy;
  verification: VerificationPolicy;
  limits: SessionLimits;
  clock: Clock;
  ids: IdSource;
}

export type OpenSessionResult =
  | { ok: true; session: AgentSession }
  | { ok: false; code: "INVALID_CONFIGURATION"; message: string; field?: string };
