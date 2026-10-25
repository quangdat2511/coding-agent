import { Box, Text, useInput, usePaste } from "ink";
import { useState } from "react";
import { type KeyAction, routeKey, routePaste } from "./input.ts";
import type { TranscriptRow } from "./rows.ts";
import { Transcript } from "./transcript.tsx";
import type { TuiHandlers } from "./types.ts";

// The rows under the transcript: the prompt, then the key hint.
export const FOOTER_HEIGHT = 2;

// The cancel key comes first, so a narrow terminal cuts the hint after it.
export const KEY_HINT = "Esc cancel · Enter submit · PgUp/PgDn scroll";

const PROMPT_MARKER = "> ";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The whole frame: the transcript rows in view, the prompt and the key hint. Every key and paste
// goes through the input policy, and this component carries out what it decides. mountTui renders
// it again for each frame, so the prompt text, kept here, survives transcript updates.
export function App({
  rows,
  height,
  handlers,
}: {
  rows: readonly TranscriptRow[];
  height: number;
  handlers: TuiHandlers;
}) {
  const [text, setText] = useState("");

  function perform(action: KeyAction) {
    switch (action.kind) {
      case "insert":
        setText((current) => current + action.text);
        return;
      case "backspace":
        setText(withoutLastCharacter);
        return;
      case "submit":
        // An empty prompt has no Coding Task to start.
        if (text.trim() !== "") {
          handlers.onSubmit(text);
          setText("");
        }
        return;
      // Not handled yet: scrolling and cancelling.
      case "scroll":
      case "cancel":
      case "ignore":
        return;
      default: {
        const unhandled: never = action;
        throw new Error(`Unhandled key action: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  useInput((input, key) => perform(routeKey("prompt", input, key)));
  usePaste((pasted) => perform(routePaste("prompt", pasted)));

  return (
    <Box flexDirection="column" height={height + FOOTER_HEIGHT}>
      <Transcript rows={rows} height={height} />
      {/* A task wider than the row shows its end, where the typing happens. The marker keeps its
          width, which Ink would otherwise shrink to make room for the text. */}
      <Box>
        <Box flexShrink={0}>
          <Text>{PROMPT_MARKER}</Text>
        </Box>
        <Text wrap="truncate-start">{text}</Text>
      </Box>
      <Text wrap="truncate-end">{KEY_HINT}</Text>
    </Box>
  );
}

// Removes the last character as the user sees it, so a letter typed as a base and a combining mark,
// or an emoji, goes in one Backspace.
function withoutLastCharacter(text: string): string {
  const last = [...graphemes.segment(text)].at(-1);
  return last === undefined ? text : text.slice(0, last.index);
}
