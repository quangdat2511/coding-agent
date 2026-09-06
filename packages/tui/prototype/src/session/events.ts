export type ApprovalDecision = "allow-once" | "allow-always" | "reject";

export type ToolCallStatus =
  | "awaiting-approval"
  | "running"
  | "ok"
  | "error"
  | "rejected"
  | "cancelled";

export type CheckStatus = "pending" | "running" | "pass" | "fail";

export type RiskLevel = "read" | "write" | "execute";

export type SessionPhase =
  | "idle"
  | "streaming"
  | "awaiting-approval"
  | "running-tool"
  | "verifying"
  | "settled"
  | "cancelled";

export interface ApprovalRequest {
  callId: string;
  question: string;
  risk: RiskLevel;
  detail: string[];
}

export interface Summary {
  outcome: "completed" | "cancelled";
  headline: string;
  filesChanged: string[];
  toolCalls: number;
  approvals: number;
  rejections: number;
  checksPassed: number;
  checksFailed: number;
  elapsedMs: number;
  tokens: number;
}

export type SessionEvent =
  | { kind: "task-started"; task: string }
  | { kind: "turn-started"; turn: number }
  | { kind: "assistant-delta"; text: string }
  | { kind: "assistant-ended" }
  | { kind: "tool-call-started"; id: string; name: string; target: string; risk: RiskLevel }
  | { kind: "approval-requested"; request: ApprovalRequest }
  | { kind: "approval-decided"; callId: string; decision: ApprovalDecision }
  | { kind: "tool-call-progress"; id: string; line: string }
  | { kind: "tool-call-ended"; id: string; status: ToolCallStatus; output: string[] }
  | { kind: "verification-started"; checks: string[] }
  | { kind: "verification-progress"; check: string; status: CheckStatus; note?: string }
  | { kind: "session-cancelled"; reason: string }
  | { kind: "session-settled"; summary: Summary };
