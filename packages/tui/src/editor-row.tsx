import { Text } from "ink";
import stringWidth from "string-width";
import { type Editor, editorView } from "./editor.ts";

// The part of an Editor's text in view, `columns` wide. Frame puts the terminal's cursor on it
// with editorCursorColumn. `fill` pads the row to its full width, for a row drawn over other text.
export function EditorRow({
  editor,
  columns,
  fill = false,
}: {
  editor: Editor;
  columns: number;
  fill?: boolean;
}) {
  const { before, at, after } = editorView(editor, columns);
  const text = before + at + after;
  const padding = fill ? " ".repeat(Math.max(0, columns - stringWidth(text))) : "";
  return <Text wrap="truncate-end">{text + padding}</Text>;
}

// How many columns into the row the cursor sits.
export function editorCursorColumn(editor: Editor, columns: number): number {
  return stringWidth(editorView(editor, columns).before);
}
