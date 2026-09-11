import type {
  ApprovalDecision,
  ApprovalRequest,
  CheckStatus,
  RiskLevel,
  SessionEvent,
  SessionPhase,
  Summary,
  ToolCallStatus,
} from "@/session/events";

export interface ToolCallView {
  id: string;
  name: string;
  target: string;
  risk: RiskLevel;
  status: ToolCallStatus;
  output: string[];
}

export interface CheckRow {
  name: string;
  status: CheckStatus;
  note?: string;
}

export type TranscriptEntry =
  | { type: "task"; text: string }
  | { type: "assistant"; text: string; streaming: boolean }
  | { type: "tool"; call: ToolCallView }
  | { type: "approval"; callId: string; question: string; decision: ApprovalDecision | null }
  | { type: "notice"; tone: "info" | "warn" | "error"; text: string }
  | { type: "verification"; rows: CheckRow[] }
  | { type: "summary"; summary: Summary };

export class SessionViewModel {
  task = "";
  phase: SessionPhase = "idle";
  transcript: TranscriptEntry[] = [];
  pendingApproval: ApprovalRequest | null = null;
  calls: ToolCallView[] = [];
  checks: CheckRow[] = [];
  summary: Summary | null = null;
  tokens = 0;
  revision = 0;

  private readonly callIndex = new Map<string, ToolCallView>();

  apply(event: SessionEvent): void {
    this.revision += 1;
    switch (event.kind) {
      case "task-started":
        this.task = event.task;
        this.phase = "streaming";
        this.transcript.push({ type: "task", text: event.task });
        break;

      case "turn-started":
        this.phase = "streaming";
        break;

      case "assistant-delta": {
        this.tokens += 1;
        const last = this.transcript.at(-1);
        if (last?.type === "assistant" && last.streaming) {
          last.text += event.text;
        } else {
          this.transcript.push({ type: "assistant", text: event.text, streaming: true });
        }
        break;
      }

      case "assistant-ended": {
        const last = this.transcript.at(-1);
        if (last?.type === "assistant") last.streaming = false;
        break;
      }

      case "tool-call-started": {
        const call: ToolCallView = {
          id: event.id,
          name: event.name,
          target: event.target,
          risk: event.risk,
          status: "running",
          output: [],
        };
        this.callIndex.set(call.id, call);
        this.calls.push(call);
        this.transcript.push({ type: "tool", call });
        this.phase = "running-tool";
        break;
      }

      case "approval-requested": {
        const call = this.callIndex.get(event.request.callId);
        if (call) call.status = "awaiting-approval";
        this.pendingApproval = event.request;
        this.phase = "awaiting-approval";
        this.transcript.push({
          type: "approval",
          callId: event.request.callId,
          question: event.request.question,
          decision: null,
        });
        break;
      }

      case "approval-decided": {
        this.pendingApproval = null;
        this.phase = "running-tool";
        const entry = this.transcript.findLast(
          (item) => item.type === "approval" && item.callId === event.callId,
        );
        if (entry?.type === "approval") entry.decision = event.decision;
        const call = this.callIndex.get(event.callId);
        if (call) call.status = event.decision === "reject" ? "rejected" : "running";
        break;
      }

      case "tool-call-progress": {
        const call = this.callIndex.get(event.id);
        if (call) call.output.push(event.line);
        break;
      }

      case "tool-call-ended": {
        const call = this.callIndex.get(event.id);
        if (call) {
          call.status = event.status;
          if (call.output.length === 0) call.output = [...event.output];
        }
        break;
      }

      case "verification-started":
        this.phase = "verifying";
        this.checks = event.checks.map((name) => ({ name, status: "pending" as CheckStatus }));
        this.transcript.push({ type: "verification", rows: this.checks });
        break;

      case "verification-progress": {
        const row = this.checks.find((item) => item.name === event.check);
        if (row) {
          row.status = event.status;
          if (event.note !== undefined) row.note = event.note;
        }
        break;
      }

      case "session-cancelled":
        this.phase = "cancelled";
        this.pendingApproval = null;
        for (const call of this.calls) {
          if (call.status === "running" || call.status === "awaiting-approval") {
            call.status = "cancelled";
          }
        }
        for (const row of this.checks) {
          if (row.status === "running" || row.status === "pending") row.status = "pending";
        }
        this.transcript.push({ type: "notice", tone: "warn", text: `Cancelled: ${event.reason}` });
        break;

      case "session-settled":
        this.summary = event.summary;
        if (this.phase !== "cancelled") this.phase = "settled";
        this.transcript.push({ type: "summary", summary: event.summary });
        break;
    }
  }
}
