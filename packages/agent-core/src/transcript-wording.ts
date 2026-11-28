import type { SkipReason } from "./events.ts";
import type { AgentResult } from "./result.ts";
import type { NormalizedToolCall } from "./state.ts";

export type ToolCallClosing =
  | { readonly outcome: "skipped"; readonly reason: SkipReason }
  | { readonly outcome: "cancelled" };

export interface TranscriptWording {
  closingToolResult(call: NormalizedToolCall, closing: ToolCallClosing): string;
  outcomeNote(result: AgentResult): string | undefined;
}
