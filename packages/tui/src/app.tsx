import { Box, Text, useInput, usePaste, useStdin, useStdout } from "ink";
import { useRef, useState } from "react";
import { type KeyAction, routeKey, routePaste } from "./input.ts";
import type { TranscriptRow } from "./rows.ts";
import { Transcript } from "./transcript.tsx";
import type { TuiHandlers } from "./types.ts";

// The rows under the transcript: the prompt, then the key hint.
export const FOOTER_HEIGHT = 2;

// The cancel keys come first, so a narrow terminal cuts the hint after them.
export const KEY_HINT = "Esc/Ctrl+C cancel · Enter submit · PgUp/PgDn scroll";

const PROMPT_MARKER = "> ";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// The whole frame: the transcript rows in view, the prompt and the key hint. Every key and paste
// goes through the input policy, and this component carries out what it decides. mountTui renders
// it again for each frame, so the prompt text, kept here, survives transcript updates. The scroll
// position stays with mountTui, which lays out the rows, so scrolling goes back to it as onScroll.
export function App({
  rows,
  height,
  handlers,
  onScroll,
}: {
  rows: readonly TranscriptRow[];
  height: number;
  handlers: TuiHandlers;
  onScroll(rows: number): void;
}) {
  const [text, setText] = useState("");
  // The text as the last action left it. Ink can deliver several key presses before React renders
  // the state they set, as with an input method's Backspace and replacement letter in one read, so
  // each action works on this rather than on `text`.
  const latestText = useRef(text);

  function perform(actions: readonly KeyAction[]) {
    let next = latestText.current;
    for (const action of actions) {
      switch (action.kind) {
        case "insert":
          next += action.text;
          break;
        case "backspace":
          next = withoutLastCharacter(next);
          break;
        case "submit": {
          // Spaces around the task, such as the one a pasted line break leaves, are not part of
          // it, and a prompt of only spaces has no Coding Task to start; Enter clears the prompt
          // either way. Input methods may send a letter composed or as a base and combining
          // marks; NFC sends the same text in one form.
          const task = next.trim();
          if (task !== "") {
            handlers.onSubmit(task.normalize("NFC"));
          }
          next = "";
          break;
        }
        case "scroll":
          // A page keeps one row of the previous view, so the reader does not lose their place.
          onScroll(action.direction * Math.max(1, height - 1));
          break;
        // Whether a task is running is the host's to know: it ignores a cancel with none. The
        // prompt keeps its text, which may be the next task.
        case "cancel":
          handlers.onCancel();
          break;
        default: {
          const unhandled: never = action;
          throw new Error(`Unhandled key action: ${JSON.stringify(unhandled)}`);
        }
      }
    }
    latestText.current = next;
    setText(next);
  }

  // Ink reads keys only from a stdin it can switch to raw mode, and throws for any other. Without
  // one, as when input is piped, the TUI still draws and takes no input. Without a terminal on
  // stdout, as when output is piped, mountTui draws nothing, and raw mode would leave the person
  // typing at a blank screen where Ctrl+C no longer stops the process, so it takes no input then
  // either. Both flags are isTTY, undefined on a plain stream, and the hooks treat only false as
  // inactive.
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const takesInput = isRawModeSupported === true && stdout.isTTY === true;
  useInput((input, key) => perform(routeKey("prompt", input, key)), { isActive: takesInput });
  usePaste((pasted) => perform(routePaste("prompt", pasted)), { isActive: takesInput });

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
