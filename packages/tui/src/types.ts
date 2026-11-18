// Public types of the Full-screen TUI (ADR 0004 §5). This file imports nothing, so no public type
// can name an Ink or React type.

// tui owns TuiModel. Coding Agent's projection (CDA-82) builds it from Session Events. Later
// tickets only add to it: new optional fields or new union members.
export interface TuiModel {
  // Oldest first. Each id is unique across the transcript and stays the same across updates.
  readonly transcript: readonly TranscriptEntry[];
  // The Approval awaiting a decision, from approval_requested. The overlay shows it until the
  // person decides, and the decision goes to onApproval with this approvalId.
  readonly pendingApproval?: PendingApproval;
}

// Not exported from index.ts, like TranscriptEntry. Consumers derive this type with
// NonNullable<TuiModel["pendingApproval"]>.
export interface PendingApproval {
  readonly approvalId: string;
  readonly toolName: string;
  // The mutation summary of approval_requested, written by the projection.
  readonly summary: string;
}

// Not exported from index.ts: the public surface is exactly the four names of ADR 0004 §5.
// Consumers derive this type with TuiModel["transcript"][number].
//
// Statuses mirror ADR 0002 §6 but are declared here, because tui imports no sibling package.
// What ends an Agent Session (a cancellation, a limit, the settled Agent Result) is an entry too,
// so the outcome of each Coding Task stays in the transcript after the next one starts.
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
      // Displayable reasoning (ADR 0002 §3), absent when the message streamed none.
      readonly reasoning?: string;
      // assistant_message_completed outcomes, plus "streaming" until that event arrives.
      readonly status: "streaming" | "completed" | "failed" | "cancelled";
    }
  | {
      readonly kind: "tool_call";
      readonly id: string;
      readonly toolName: string;
      // One line describing the call's arguments, written by the projection.
      readonly summary: string;
      // tool_call_completed outcomes, plus "queued" after tool_call_queued, "awaiting_approval"
      // after approval_requested and "executing" after tool_execution_started.
      readonly status:
        | "queued"
        | "awaiting_approval"
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
      // Why a skipped call never ran: "CANCELLED" or an Agent Failure code, kept as a plain string.
      readonly skipReason?: string;
      // The latest tail of an executing call's output (Tool Progress). Each update replaces the
      // previous one, and it is absent once the call completes.
      readonly progress?: string;
    }
  | {
      readonly kind: "verification";
      readonly id: string;
      // verification_completed outcomes, plus "running" after verification_started.
      readonly status: "running" | "succeeded" | "continue" | "failed" | "cancelled";
      // One line per piece of Verification Evidence, written by the projection.
      readonly evidence?: readonly string[];
    }
  | {
      // Something that happened to the Agent Session as a whole, such as a requested
      // cancellation or a limit reached. One line, written by the projection.
      readonly kind: "notice";
      readonly id: string;
      readonly text: string;
    }
  | {
      // The settled Agent Result, the last entry of its Agent Session.
      readonly kind: "outcome";
      readonly id: string;
      readonly status: "succeeded" | "failed" | "cancelled";
      // The failure of a failed session. code is an Agent Failure code, kept as a plain string.
      readonly failure?: { readonly code: string; readonly message: string };
      readonly workspaceChanged: boolean;
      readonly partialChangesPossible: boolean;
    };

// Decisions the person makes in the TUI. onApproval mirrors ADR 0002's resolve_approval command.
export type TuiHandlers = {
  // The Coding Task typed in the Prompt, which may hold line breaks.
  onSubmit(text: string): void;
  onCancel(): void;
  // The overlay closes as soon as the person decides and never opens again for this approvalId,
  // so one Approval is never decided twice. The host takes the Approval out of the model, or sends
  // one with a new approvalId when it needs another decision, as when resolve_approval fails.
  onApproval(approvalId: string, decision: "allow" | "deny", reason?: string): void;
};

export interface TuiHandle {
  update(model: TuiModel): void;
  unmount(): Promise<void>;
}
