import { Box, Text } from "ink";
import type { TranscriptEntry, TuiModel } from "./types.ts";

type Entry<Kind extends TranscriptEntry["kind"]> = Extract<TranscriptEntry, { kind: Kind }>;

const TAB = "    ";
const ESC = "\u001b";

export function Transcript({ model }: { model: TuiModel }) {
  return (
    <Box flexDirection="column" gap={1}>
      {model.transcript.map((entry) => (
        <TranscriptItem key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}

function TranscriptItem({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "user":
      return <UserItem entry={entry} />;
    case "assistant":
      return <AssistantItem entry={entry} />;
    case "tool_call":
      return <ToolCallItem entry={entry} />;
    default: {
      const unhandled: never = entry;
      throw new Error(`Unhandled transcript entry: ${JSON.stringify(unhandled)}`);
    }
  }
}

function UserItem({ entry }: { entry: Entry<"user"> }) {
  return (
    <Box>
      <Text>{"> "}</Text>
      <Text>{toDisplayText(entry.text)}</Text>
    </Box>
  );
}

function AssistantItem({ entry }: { entry: Entry<"assistant"> }) {
  return (
    <Box flexDirection="column">
      <Text>{`assistant [${entry.status}]`}</Text>
      <Text>{toDisplayText(entry.text)}</Text>
    </Box>
  );
}

function ToolCallItem({ entry }: { entry: Entry<"tool_call"> }) {
  const { result } = entry;
  // Status, error code and truncation are spelled out because colors depend on the terminal.
  const details = [entry.status, result?.errorCode, result?.truncated ? "truncated" : undefined]
    .filter(Boolean)
    .join(", ");
  const header = [entry.toolName, entry.summary, `[${details}]`].filter(Boolean).join(" ");
  return (
    <Box flexDirection="column">
      <Text>{toDisplayText(header)}</Text>
      {result === undefined ? null : (
        <Box paddingLeft={2}>
          <Text>{toDisplayText(result.content)}</Text>
        </Box>
      )}
    </Box>
  );
}

// Ink strips escape sequences other than colors and links but writes other control characters as
// they are. A tab or carriage return would then move the cursor away from where Ink's layout put
// it and break the in-place redraw, so they are replaced before Ink sees the text.
function toDisplayText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, TAB)
    .replace(/\p{Cc}/gu, (char) => (char === "\n" || char === ESC || char >= "\u0080" ? char : ""));
}
