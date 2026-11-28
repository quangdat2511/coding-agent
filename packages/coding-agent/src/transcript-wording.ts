import type {
  AgentFailure,
  JsonValue,
  LimitKind,
  SkipReason,
  TranscriptWording,
} from "@coding-agent/agent-core";
import { escapeAttribute } from "./system-prompt.ts";

const NOT_RUN_AFTER_CANCELLATION =
  "Not run: the person cancelled the Coding Task before this call started.";
const NOT_RUN = "Not run: the Coding Task ended before this call started.";
const STOPPED =
  "Stopped: the Coding Task ended while this call was running, and the call returned no result. " +
  "It may have changed the repository partly.";

const CANCELLED_NOTE =
  "The person cancelled this Coding Task before it finished. Do not continue it unless they ask. " +
  "Tools that were stopped may have changed the repository partly.";
const MODEL_REQUEST_FAILED_NOTE =
  "This Coding Task stopped before it finished because a model request failed.";
const CANCELLATION_TIMEOUT_NOTE =
  "The person cancelled this Coding Task, but a tool did not stop in time and may still be " +
  "changing the repository.";
const INTERNAL_ERROR_NOTE =
  "This Coding Task stopped before it finished because of an internal error in Coding Agent.";
const limitExceededNote = (limit: string): string =>
  `This Coding Task stopped before it finished: it reached the limit of ${limit}. ` +
  "Its work may be incomplete.";
const verificationFailedNote = (message: string): string =>
  `This Coding Task was not verified: ${message}.`;

// A grace period that expires is always a cancellation's, since a Run Limit's settles as the limit.
const CANCELLATIONS: ReadonlySet<SkipReason> = new Set(["CANCELLED", "CANCELLATION_TIMEOUT"]);

const MINUTE_MS = 60_000;

const counted = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`;

const LIMITS: Readonly<Record<LimitKind, (limit: number) => string>> = {
  maxModelTurns: (limit) => counted(limit, "model turn", "model turns"),
  maxToolCalls: (limit) => counted(limit, "tool call", "tool calls"),
  maxDurationMs: (limit) =>
    limit % MINUTE_MS === 0
      ? `${counted(limit / MINUTE_MS, "minute", "minutes")} of active work`
      : `${counted(limit / 1_000, "second", "seconds")} of active work`,
  maxConsecutiveRecoverableFailures: (limit) =>
    counted(limit, "consecutive failed tool call", "consecutive failed tool calls"),
};

const isLimitKind = (kind: JsonValue | undefined): kind is LimitKind =>
  typeof kind === "string" && Object.hasOwn(LIMITS, kind);

function limitOf(details: Readonly<Record<string, JsonValue>> | undefined): string {
  const kind = details?.kind;
  const limit = details?.limit;
  if (!isLimitKind(kind) || typeof limit !== "number") {
    throw new Error("the LIMIT_EXCEEDED failure does not name the limit it reached");
  }
  return LIMITS[kind](limit);
}

const note = (status: string, content: string): string =>
  `<task_outcome status="${escapeAttribute(status)}">${escapeAttribute(content)}</task_outcome>`;

function failureNote(failure: AgentFailure): string {
  switch (failure.code) {
    case "LIMIT_EXCEEDED":
      return note("limit_exceeded", limitExceededNote(limitOf(failure.details)));
    case "VERIFICATION_FAILED":
      return note("verification_failed", verificationFailedNote(failure.message));
    case "MODEL_FAILURE":
      return note("model_failure", MODEL_REQUEST_FAILED_NOTE);
    case "MODEL_PROTOCOL_ERROR":
      return note("model_protocol_error", MODEL_REQUEST_FAILED_NOTE);
    case "CANCELLATION_TIMEOUT":
      return note("cancellation_timeout", CANCELLATION_TIMEOUT_NOTE);
    case "INTERNAL_ERROR":
      return note("internal_error", INTERNAL_ERROR_NOTE);
    default: {
      const unhandled: never = failure;
      throw new Error(`Unhandled Agent Failure: ${JSON.stringify(unhandled)}`);
    }
  }
}

export const transcriptWording: TranscriptWording = {
  closingToolResult(_call, closing) {
    if (closing.outcome === "cancelled") return STOPPED;
    return CANCELLATIONS.has(closing.reason) ? NOT_RUN_AFTER_CANCELLATION : NOT_RUN;
  },
  outcomeNote(result) {
    switch (result.outcome) {
      case "succeeded":
        return undefined;
      case "cancelled":
        return note("cancelled", CANCELLED_NOTE);
      case "failed":
        return failureNote(result.failure);
    }
  },
};
