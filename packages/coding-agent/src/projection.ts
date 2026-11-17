import type {
  AgentResult,
  SessionEvent,
  ToolResult,
  VerificationEvidence,
} from "@coding-agent/agent-core";
import type { AssistantMessage } from "@coding-agent/ai";
import type { TuiModel } from "@coding-agent/tui";

// The Session Event to TuiModel projection (ADR 0004 §6). It is pure: it performs no I/O, never
// mutates prev, and returns prev itself when an event changes nothing the TUI shows. Only the
// entry an event changes is replaced, so the TUI keeps the layout of every other entry.

type TranscriptEntry = TuiModel["transcript"][number];
type EntryKind = TranscriptEntry["kind"];
type Entry<Kind extends EntryKind> = Extract<TranscriptEntry, { kind: Kind }>;

// The longest Tool Call summary, in characters. A summary is one line under the TUI's width.
const SUMMARY_LENGTH = 120;

// The argument that names what a known tool acts on. Other tools show all their arguments.
const SUMMARY_ARGUMENT: Readonly<Record<string, string>> = {
  read: "path",
  write: "path",
  edit: "path",
  bash: "command",
};

export function projectSessionEvent(event: SessionEvent, prev: TuiModel): TuiModel {
  switch (event.type) {
    case "session_started":
      // A TUI runs one Agent Session after another, so the transcript keeps earlier sessions.
      return append(withoutPendingApproval(prev), {
        kind: "user",
        id: entryId(event, "task"),
        text: event.data.task.objective,
      });

    case "model_turn_started":
    case "model_turn_completed":
    case "candidate_completion_detected":
    case "verification_progress":
      // A failed Model Turn shows on its Assistant Message and in the settled outcome. The MVP
      // emits no verification_progress.
      return prev;

    case "assistant_message_started":
      return append(prev, {
        kind: "assistant",
        id: entryId(event, "message", event.data.messageId),
        text: "",
        status: "streaming",
      });

    case "assistant_content_delta": {
      const { kind, delta } = event.data;
      return replace(
        prev,
        "assistant",
        entryId(event, "message", event.data.messageId),
        (entry) => {
          if (entry.status !== "streaming" || delta === "") return entry;
          return kind === "reasoning"
            ? { ...entry, reasoning: (entry.reasoning ?? "") + delta }
            : { ...entry, text: entry.text + delta };
        },
      );
    }

    case "assistant_message_completed": {
      const { outcome, message } = event.data;
      return replace(
        prev,
        "assistant",
        entryId(event, "message", event.data.messageId),
        (entry) => {
          // The completed message is authoritative. A message cut off before any text keeps what
          // streamed. Reasoning is not part of the message, so it keeps what streamed too.
          const text = textOf(message);
          return { ...entry, text: text === "" ? entry.text : text, status: outcome };
        },
      );
    }

    case "tool_call_queued": {
      const { toolCall } = event.data;
      return append(prev, {
        kind: "tool_call",
        id: entryId(event, "tool_call", toolCall.id),
        toolName: toolCall.name,
        summary: summarizeArguments(toolCall.name, toolCall.arguments),
        status: "queued",
      });
    }

    case "approval_requested": {
      // Under auto-approve the Approval resolves in the next event and nobody is asked, so no
      // overlay opens.
      if (event.data.policy === "auto-approve") return prev;
      const id = entryId(event, "tool_call", event.data.toolCallId);
      const call = findEntry(prev, "tool_call", id);
      const next = replace(prev, "tool_call", id, (entry) =>
        hasStarted(entry) ? entry : { ...entry, status: "awaiting_approval" },
      );
      return {
        ...next,
        // approvalId stays the session's own, because the overlay hands it back to onApproval.
        pendingApproval: {
          approvalId: event.data.approvalId,
          toolName: call?.toolName ?? "tool",
          summary: event.data.summary,
        },
      };
    }

    case "approval_resolved": {
      const { approvalId, status } = event.data;
      const closed =
        prev.pendingApproval?.approvalId === approvalId ? withoutPendingApproval(prev) : prev;
      if (status !== "allowed" && status !== "auto_approved") {
        // A denied or cancelled call completes in the next event, which carries its Tool Result.
        return closed;
      }
      return replace(
        closed,
        "tool_call",
        entryId(event, "tool_call", event.data.toolCallId),
        (entry) => (entry.status === "awaiting_approval" ? { ...entry, status: "queued" } : entry),
      );
    }

    case "tool_execution_started":
      return replace(
        prev,
        "tool_call",
        entryId(event, "tool_call", event.data.toolCallId),
        (entry) => (hasStarted(entry) ? entry : { ...entry, status: "executing" }),
      );

    case "tool_execution_progress": {
      const { output } = event.data.update;
      return replace(
        prev,
        "tool_call",
        entryId(event, "tool_call", event.data.toolCallId),
        (entry) =>
          entry.status !== "executing" || entry.progress === output
            ? entry
            : { ...entry, progress: output },
      );
    }

    case "tool_call_completed": {
      const { data } = event;
      return replace(prev, "tool_call", entryId(event, "tool_call", data.toolCallId), (entry) => {
        const { progress: _cleared, ...call } = entry;
        if (data.outcome === "skipped") {
          // A Skipped Tool Call never gets a Tool Result (ADR 0002 §3).
          return { ...call, status: "skipped" };
        }
        return data.result === undefined
          ? { ...call, status: data.outcome }
          : { ...call, status: data.outcome, result: toolResultOf(data.result) };
      });
    }

    case "verification_started":
      return append(prev, {
        kind: "verification",
        id: entryId(event, "verification", event.data.verificationId),
        status: "running",
      });

    case "verification_completed": {
      const { outcome, evidence } = event.data;
      const id = entryId(event, "verification", event.data.verificationId);
      return replace(prev, "verification", id, (entry) => {
        const lines = evidence.map(describeEvidence);
        return lines.length === 0
          ? { ...entry, status: outcome }
          : { ...entry, status: outcome, evidence: lines };
      });
    }

    case "cancellation_requested": {
      const { reason } = event.data;
      return append(prev, {
        kind: "notice",
        id: entryId(event, "notice", String(event.sequence)),
        text: reason === undefined ? "cancellation requested" : `cancellation requested: ${reason}`,
      });
    }

    case "runtime_limit_reached": {
      const { kind, limit, observed } = event.data;
      return append(prev, {
        kind: "notice",
        id: entryId(event, "notice", String(event.sequence)),
        text: `limit reached: ${kind} (observed ${observed}, limit ${limit})`,
      });
    }

    case "session_settled":
      return append(
        withoutPendingApproval(prev),
        outcomeOf(entryId(event, "outcome"), event.data.result),
      );

    default: {
      const unhandled: never = event;
      throw new Error(`Unhandled Session Event: ${JSON.stringify(unhandled)}`);
    }
  }
}

// Entry ids carry the session id, because the transcript spans every session the TUI has run and
// Agent Core IDs are unique only within one session.
function entryId(event: SessionEvent, kind: string, id?: string): string {
  return id === undefined ? `${event.sessionId}/${kind}` : `${event.sessionId}/${kind}/${id}`;
}

function append(model: TuiModel, entry: TranscriptEntry): TuiModel {
  return { ...model, transcript: [...model.transcript, entry] };
}

function findEntry<Kind extends EntryKind>(
  model: TuiModel,
  kind: Kind,
  id: string,
): Entry<Kind> | undefined {
  const entry = model.transcript.findLast((candidate) => candidate.id === id);
  return entry?.kind === kind ? (entry as Entry<Kind>) : undefined;
}

// Replaces the entry with this id and kind by what change returns. The model stays prev when the
// entry is missing or change returns it unchanged.
function replace<Kind extends EntryKind>(
  model: TuiModel,
  kind: Kind,
  id: string,
  change: (entry: Entry<Kind>) => Entry<Kind>,
): TuiModel {
  const index = model.transcript.findLastIndex((candidate) => candidate.id === id);
  const entry = model.transcript[index];
  if (entry?.kind !== kind) return model;
  const next = change(entry as Entry<Kind>);
  return next === entry ? model : { ...model, transcript: model.transcript.with(index, next) };
}

function withoutPendingApproval(model: TuiModel): TuiModel {
  if (model.pendingApproval === undefined) return model;
  const { pendingApproval: _closed, ...rest } = model;
  return rest;
}

// A call that has started executing or has completed. No later event moves it back.
function hasStarted(entry: Entry<"tool_call">): boolean {
  return entry.status !== "queued" && entry.status !== "awaiting_approval";
}

function textOf(message: AssistantMessage): string {
  return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}

function toolResultOf(result: ToolResult): NonNullable<Entry<"tool_call">["result"]> {
  return {
    content: result.content,
    isError: result.isError,
    ...(result.error === undefined ? {} : { errorCode: result.error.code }),
    ...(result.metadata?.truncated ? { truncated: true } : {}),
  };
}

function describeEvidence(evidence: VerificationEvidence): string {
  switch (evidence.type) {
    case "command_execution":
      return `${evidence.command} exited ${evidence.exitCode}`;
    case "command_system_failure":
      return evidence.failureKind === "timed_out"
        ? `${evidence.command} timed out`
        : `${evidence.command} failed to launch: ${evidence.message}`;
    case "no_command_configured":
      return "no verification command configured";
    default: {
      const unhandled: never = evidence;
      throw new Error(`Unhandled Verification Evidence: ${JSON.stringify(unhandled)}`);
    }
  }
}

function outcomeOf(id: string, result: AgentResult): Entry<"outcome"> {
  const { workspaceChanged, partialChangesPossible } = result;
  return result.outcome === "failed"
    ? {
        kind: "outcome",
        id,
        status: "failed",
        failure: { code: result.failure.code, message: result.failure.message },
        workspaceChanged,
        partialChangesPossible,
      }
    : { kind: "outcome", id, status: result.outcome, workspaceChanged, partialChangesPossible };
}

// One line naming what a Tool Call acts on: the path or command of a known tool, otherwise every
// argument. Arguments that are not a JSON object, as a model may send, show as they came.
function summarizeArguments(toolName: string, args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return oneLine(args);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return oneLine(args);
  }
  const entries = Object.entries(parsed);
  const key = SUMMARY_ARGUMENT[toolName];
  const named = entries.find(([name]) => name === key)?.[1];
  if (typeof named === "string") return oneLine(named);
  return oneLine(
    entries
      .map(
        ([name, value]) => `${name}=${typeof value === "string" ? value : JSON.stringify(value)}`,
      )
      .join(" "),
  );
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(line);
  return characters.length <= SUMMARY_LENGTH
    ? line
    : `${characters.slice(0, SUMMARY_LENGTH - 1).join("")}…`;
}
