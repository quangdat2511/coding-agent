import type { Context, Model, ModelCapabilities, ModelStream } from "@coding-agent/ai";

export type ApprovalPolicy = "ask" | "auto-approve";

export interface ModelPort {
  readonly identity: Model;
  readonly capabilities: ModelCapabilities;
  stream(
    context: Context,
    request: { readonly signal: AbortSignal; readonly parallelToolCalls: false },
  ): ModelStream;
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
  readonly maxModelTurns: number;
  readonly maxToolCalls: number;
  readonly maxDurationMs: number;
  readonly maxConsecutiveRecoverableFailures: number;
  readonly cancellationGraceMs: number;
}
