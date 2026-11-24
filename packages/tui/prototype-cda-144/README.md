# PROTOTYPE: queue strip, queue selection mode and session picker (CDA-144)

Throwaway. Not shipped, not tested, never merged into `main`. It answers CDA-144: how the Prompt
Queue strip, the queue selection mode and the session picker should look and behave, and which
keys drive them, with their Windows variants.

Four variants run on the real transcript rows, editor and viewport of `packages/tui/src`, behind a
fake Coding Agent that follows CDA-140's Prompt Queue rules (one Steer taken before each Model
Turn, the edit lock, Steers left at settlement becoming head Follow-ups, Follow-ups starting only
after a success) and a scripted run of four Model Turns, one every 2.5 s.

## Run it

```bash
bun packages/tui/prototype-cda-144/main.tsx
bun packages/tui/prototype-cda-144/main.tsx --variant=A --scene=failed --keys=windows
FORCE_COLOR=1 bun packages/tui/prototype-cda-144/snapshot.ts
```

The last command renders every variant in every scene into `snapshots.txt` (gutter `#` marks the
selected row, `.` a dimmed one).

In the app, Tab and Shift+Tab switch variant, `::help` lists scenes and commands, and `::echo`
shows what each candidate chord arrives as in the terminal you run it in. Scenes start with time
paused; `::play` or `::step` moves the run on.

## Variants

**D was chosen** (see the resolution on CDA-144). A to C were the first round; D takes A's strip
and adds the frame and badges, from an HTML mockup the choice was made on.

- **A, Rows.** One dimmed strip row per item, `Steering: ...` then `Follow-up: ...`, at most six
  with "N more". Up on the Prompt's first row walks into the strip; Enter sends now, `e` edits the
  row in place, `d` deletes. Picker: a full-height table (name, last activity, tasks, status).
- **B, Summary + panel.** At most two strip rows, `Steering (2): first (+1)` and
  `Follow-ups (3): first (+2)`. Shift+Up opens a bordered panel over the transcript listing every
  item with the selected one's full text; edits happen in the panel. Picker: a box over the
  transcript with a filter and two rows per Session.
- **C, Prompt recall.** One ruled row with counts. Up on the Prompt's first row recalls the nearest
  item into the Prompt like shell history and locks it while shown; typing edits it, Enter saves,
  the Follow-up key sends it now, Ctrl+D deletes, Down past the last item returns to the draft.
  Picker: a split list with a preview of the Session's last entries.
- **D, Framed.** A frame around the whole screen. The top border names the Session and the
  repository, with the run state on the right (spinner and turn, `! waiting`, or `● idle`). Below
  the transcript, between two separators, A's strip with a badge per row: `STEER`, `NEXT`, or an
  amber `WAIT` for Follow-ups waiting after an unsuccessful run, with the reason above them.
  Shift+Up selects in the strip and the selected row shows its full text; Enter sends a Follow-up
  now, `e` edits in the row, `d` deletes, Esc goes back. The bottom border holds the key hints or a
  notice, and the counts. Picker: a full-height list inside the frame with a status dot per
  Session. Hints use macOS symbols on macOS (`::words` switches) and words elsewhere.

## Keys the prototype binds

| Action | macOS, Linux | Windows, WSL |
| :--- | :--- | :--- |
| Run a task, or send a Steer during a run | Enter | Enter |
| Queue a Follow-up (runs at once when idle) | Alt+Enter | Ctrl+Q, and Alt+Enter unlisted |
| New line | Shift+Enter, Ctrl+J | Shift+Enter, Ctrl+J (Ctrl+Enter arrives as Ctrl+J) |
| Enter the queue | Shift+Up (A and C also take Up on the Prompt's first row) | same |
| Every queued item back into the Prompt | Alt+Up | Alt+Q |
| New Session | Ctrl+N | Ctrl+N |
| Resume list | Ctrl+R | Ctrl+R |
| Leave the queue, an edit or the picker | Esc (Ctrl+C still cancels the run) | same |
