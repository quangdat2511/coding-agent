import type { Context, Model, ModelCapabilities, ModelStream } from "@coding-agent/ai";

export type ApprovalPolicy = "ask" | "auto-approve";

export interface ModelPort {
  readonly identity: Model;
  readonly capabilities: ModelCapabilities;
  stream(context: Context, request: { signal: AbortSignal; parallelToolCalls: false }): ModelStream;
}

export interface Clock {
  now(): string;
  monotonicMs(): number;
}

export type IdKind =
  | "session"
  | "model_turn"
  | "assistant_message"
  | "tool_call"
  | "approval"
  | "verification";

export interface IdSource {
  next(kind: IdKind): string;
}

export interface SessionLimits {
  maxModelTurns: number;
  maxToolCalls: number;
  maxDurationMs: number;
  maxConsecutiveRecoverableFailures: number;
  cancellationGraceMs: number;
}
