import type { Message } from "@coding-agent/ai";
import type { RunEvent } from "./events.ts";
import type { ApprovalPolicy, Clock, IdSource, ModelPort, RunLimits } from "./ports.ts";
import type { AgentResult } from "./result.ts";
import type { AgentState } from "./state.ts";
import type { CodingTask } from "./task.ts";
import type { ToolRegistry } from "./tool.ts";
import type { TranscriptWording } from "./transcript-wording.ts";
import type { VerificationPolicy } from "./verification.ts";
import type { WorkspaceResolver } from "./workspace.ts";

export type RunCommand =
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

export interface AgentRun {
  dispatch(command: RunCommand): Promise<CommandResult>;
  snapshot(): AgentState;
  events(afterSequence?: number): AsyncIterable<RunEvent>;
  result(): Promise<AgentResult>;
}

export interface OpenRunConfig {
  readonly model: ModelPort;
  readonly systemPrompt: string;
  readonly tools: ToolRegistry;
  readonly workspace: WorkspaceResolver;
  readonly approvalPolicy: ApprovalPolicy;
  readonly verification: VerificationPolicy;
  readonly limits: RunLimits;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly transcript?: readonly Message[];
  readonly wording: TranscriptWording;
}

export type OpenRunResult =
  | { readonly ok: true; readonly run: AgentRun }
  | {
      readonly ok: false;
      readonly code: "INVALID_CONFIGURATION";
      readonly message: string;
      readonly field?: string;
    };
