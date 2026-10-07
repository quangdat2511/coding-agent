import type { SessionEvent } from "@/events";
import type { ApprovalPolicy, Clock, IdSource, ModelPort, SessionLimits } from "@/ports";
import type { AgentResult } from "@/result";
import type { AgentState } from "@/state";
import type { CodingTask } from "@/task";
import type { ToolRegistry } from "@/tool";
import type { VerificationPolicy } from "@/verification";
import type { WorkspaceResolver } from "@/workspace";

export type SessionCommand =
  | { readonly type: "start"; readonly task: CodingTask }
  | {
      readonly type: "resolve_approval";
      readonly approvalId: string;
      readonly decision: "allow" | "deny";
      readonly reason?: string;
    }
  | { readonly type: "cancel"; readonly reason?: string };

export type CommandResult =
  | { readonly accepted: true; readonly sequence: number }
  | {
      readonly accepted: false;
      readonly code: "INVALID_STATE" | "ALREADY_STARTED" | "STALE_APPROVAL" | "ALREADY_SETTLED";
      readonly message: string;
    };

export interface AgentSession {
  dispatch(command: SessionCommand): Promise<CommandResult>;
  snapshot(): AgentState;
  events(afterSequence?: number): AsyncIterable<SessionEvent>;
  result(): Promise<AgentResult>;
}

export interface OpenSessionConfig {
  readonly model: ModelPort;
  readonly systemPrompt: string;
  readonly tools: ToolRegistry;
  readonly workspace: WorkspaceResolver;
  readonly approvalPolicy: ApprovalPolicy;
  readonly verification: VerificationPolicy;
  readonly limits: SessionLimits;
  readonly clock: Clock;
  readonly ids: IdSource;
}

export type OpenSessionResult =
  | { readonly ok: true; readonly session: AgentSession }
  | {
      readonly ok: false;
      readonly code: "INVALID_CONFIGURATION";
      readonly message: string;
      readonly field?: string;
    };
