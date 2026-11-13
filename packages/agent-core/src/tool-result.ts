export type ToolErrorCode =
  | "SCHEMA_VIOLATION"
  | "NOT_FOUND"
  | "IS_DIRECTORY"
  | "PATH_OUTSIDE_REPO"
  | "PERMISSION_DENIED"
  | "NO_MATCH"
  | "AMBIGUOUS_MATCH"
  | "PARENT_CREATION_FAILED"
  | "TIMEOUT"
  | "SIGNAL"
  | "NON_ZERO_EXIT"
  | "APPROVAL_DENIED"
  | "TOOL_INTERNAL_ERROR";

export interface ToolError {
  readonly code: ToolErrorCode;
  readonly message: string;
}

export type ApprovalStatus = "allowed" | "denied" | "auto_approved";

export type ApprovalDecider = "user" | "policy";

export interface ToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
  readonly error?: ToolError;
  readonly metadata?: {
    readonly durationMs: number;
    readonly approval?: {
      readonly status: ApprovalStatus;
      readonly decidedBy: ApprovalDecider;
      readonly reason?: string;
    };
    readonly truncated?: boolean;
  };
}

// The latest tail of a running tool's output. Each update replaces the previous one.
export interface ToolProgress {
  readonly output: string;
}
