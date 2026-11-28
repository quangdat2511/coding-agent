import { Box, Text } from "ink";
import type { SessionViewRow } from "./rows.ts";

// Draws the rows in view, one <Text> per terminal row, in a box exactly `height` rows tall. A frame
// of constant height never takes Ink's path for frames that shrink below the screen, which clears
// the screen and the scrollback. An empty <Text> takes no height, so a blank row is drawn as a
// space. Rows are already wrapped to the terminal width; truncation only guards against a row Ink
// measures wider, which would take two rows and push the frame past the screen.
export function SessionView({ rows, height }: { rows: readonly SessionViewRow[]; height: number }) {
  return (
    <Box flexDirection="column" height={height}>
      {rows.map((row) => (
        <Text key={`${row.entryId}:${row.offset}`} wrap="truncate-end">
          {row.text === "" ? " " : row.text}
        </Text>
      ))}
    </Box>
  );
}
