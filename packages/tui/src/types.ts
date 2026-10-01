// Public types of the Full-screen TUI (ADR 0004 §5). This file imports nothing, so no public type
// can name an Ink or React type.

// tui owns TuiModel. Coding Agent's projection (CDA-82) builds it from Session Events. Later
// tickets only add to it: new optional fields or new union members.
export interface TuiModel {
  // Oldest first. Each id is unique across the transcript and stays the same across updates.
  readonly transcript: readonly TranscriptEntry[];
  // Planned optional fields:
  // - pendingApproval (CDA-60): the Approval awaiting a decision, answered through onApproval.
  // - session: the Agent Session status shown outside the transcript.
  // - limitNotice: limit kind, configured limit and observed value from runtime_limit_reached.
}

// Not exported from index.ts: the public surface is exactly the four names of ADR 0004 §5.
// Consumers derive this type with TuiModel["transcript"][number].
//
// Statuses mirror ADR 0002 §6 but are declared here, because tui imports no sibling package.
// Planned member: a Verification entry carrying verification_completed's outcomes.
export type TranscriptEntry =
  | {
      readonly kind: "user";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      // assistant_message_completed outcomes, plus "streaming" until that event arrives.
      // Planned optional field: displayable reasoning (ADR 0002 §3).
      readonly status: "streaming" | "completed" | "failed" | "cancelled";
    }
  | {
      readonly kind: "tool_call";
      readonly id: string;
      readonly toolName: string;
      // One line describing the call's arguments, written by the projection.
      readonly summary: string;
      // tool_call_completed outcomes, plus "queued" after tool_call_queued and "executing" after
      // tool_execution_started. Planned member: "awaiting_approval" (CDA-60).
      readonly status:
        | "queued"
        | "executing"
        | "succeeded"
        | "failed"
        | "denied"
        | "cancelled"
        | "skipped";
      // Absent until a Tool Result is recorded. A skipped call never gets one (ADR 0002 §3).
      readonly result?: {
        readonly content: string;
        readonly isError: boolean;
        // An ADR 0001 ToolErrorCode, kept as a plain string.
        readonly errorCode?: string;
        readonly truncated?: boolean;
      };
    };

// Decisions the person makes in the TUI. onApproval mirrors ADR 0002's resolve_approval command.
export type TuiHandlers = {
  onSubmit(text: string): void;
  onCancel(): void;
  onApproval(approvalId: string, decision: "allow" | "deny", reason?: string): void;
};

export interface TuiHandle {
  update(model: TuiModel): void;
  unmount(): Promise<void>;
}
