# Key Chords That Reach the Full-screen TUI

**Ticket:** CDA-137  
**Research Date:** 2026-11-23  
**Context:** Input for CDA-144 (queue strip, queue selection mode, session picker, and their keys)  
**Scope:** Which candidate key chords the Full-screen TUI (`@coding-agent/tui`, Ink 7.1.1 on Bun) can
tell apart in macOS Terminal, iTerm2, kitty, Ghostty, the VS Code integrated terminal and Windows
Terminal, on Linux, macOS and Windows. This note lists candidates and caveats; it does not pick keys.

---

## 1. Question

Which key chords can the Full-screen TUI tell apart in common terminals, given how
`packages/tui/src/input.ts` reads Ink's key reports? The candidates are Alt+Enter, Shift+Enter,
Ctrl+J, Alt+Up, Ctrl+Q and Alt+Q, plus free chords for starting a new Session, opening the resume
list and entering the Prompt Queue. Which terminal intercepts which chord, does the kitty keyboard
protocol change the answer, and what does Pi bind for these actions and why?

Today Enter submits the Prompt, Shift+Enter, Alt+Enter and Ctrl+J insert a line break, and Esc and
Ctrl+C cancel or quit ([`CONTEXT.md` L13-L16](../../packages/tui/CONTEXT.md#L13-L16),
[`input.ts` L111-L170](../../packages/tui/src/input.ts#L111-L170)). Per the CDA-137 ticket, Stage 1
plans, following Pi, that Enter during an active run sends a Steer, Alt+Enter queues a Follow-up
(Ctrl+Q on Windows) and no longer starts a line, Alt+Up pulls the queue back into the Prompt
(Alt+Q on Windows), and Esc returns the queue to the Prompt and cancels.

---

## 2. Short Answer

- **The kitty keyboard protocol decides most of it.** The TUI asks every terminal for it
  (Ink `kittyKeyboard: { mode: "auto" }`, flag 1 only). Where the terminal answers (kitty, Ghostty,
  iTerm2, VS Code 1.109 and later), Shift+Enter, Ctrl+J and Ctrl+letter arrive as distinct `CSI u`
  reports, and so do Alt chords once Option counts as Alt on macOS. macOS Terminal does not speak
  it, so there Shift+Enter is plain Enter. Windows Terminal supports it from 1.25, but no source settles whether
  the mode reaches a native Windows process behind ConPTY.
- **Terminals and editors take some chords before the TUI sees them.** Windows Terminal takes
  Alt+Enter (full screen) always and Alt+Up only when a pane lies above. VS Code takes Ctrl+Q on
  Windows and macOS (Quick Open View), Ctrl+J on Windows and Linux (Toggle Panel), Ctrl+Up on
  Windows and Linux (Scroll To Previous Command), and Alt+Up on Windows and Linux only while the
  terminal is split. macOS takes Ctrl+Up for Mission Control. Ghostty on Linux takes Ctrl+Enter
  (full screen).
- **Option on macOS breaks Alt+letter by default.** macOS Terminal, iTerm2, kitty and VS Code all
  compose a character for Option+Q unless the user turns Option into Meta or Alt. Ghostty treats
  Option as Alt by default only on U.S. layouts, and always for Option with Enter or an arrow.
  iTerm2 reports Option as Alt for arrows by default and VS Code sends Alt for Enter and arrows,
  but the docs of macOS Terminal, iTerm2 (for Return) and kitty do not say what Option+Return or
  Option+Up send by default.
- **No default binds Ctrl+N or Ctrl+R** in the five terminals whose defaults are published (macOS
  Terminal documents none), apart from VS Code taking Ctrl+R in accessibility mode. Pi binds no default key for new Session or resume (it uses `/new` and
  `/resume`) and has no "enter the queue" action at all.
- **Pi's Windows fallbacks** come from its issue #8372: Windows Terminal binds Alt+Enter to full
  screen, so Pi uses Ctrl+Q (borrowed from "GHC CLI"); Alt+Q replaces Alt+Up under the general aim
  of avoiding Windows Terminal's reserved shortcuts, which bind Alt+Up to pane focus. Pi applies
  them to WSL too.

---

## 3. What Arrives, per Chord and Terminal

"Distinct" means the chord reaches the TUI and Ink reports it with flags the input policy can tell
from every other chord. "Taken" means the terminal, editor or OS consumes it in its default
configuration. "Not settled" means the sources read for this note do not say. Byte forms are in
section 4; every cell is sourced there.

| Chord | macOS Terminal | iTerm2 | kitty | Ghostty | VS Code terminal | Windows Terminal |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Kitty protocol after Ink's query | No | Yes | Yes | Yes | Yes, 1.109 and later | 1.25 and later; reaching a native Windows process not settled |
| Shift+Enter | Same as Enter; one Pi report measured ESC CR, which reads as Alt+Enter | Distinct | Distinct | Distinct | Distinct | Same as Enter without kitty mode |
| Alt+Enter | Not settled (Apple documents only "Use Option as Meta key") | Not settled with the default Option setting | Linux: distinct. macOS: not settled | Distinct | Distinct | Taken: toggle full screen |
| Ctrl+Enter | Not settled | Not settled | Distinct | Linux: taken (full screen). macOS: not settled | Kitty mode: distinct. Legacy: same as Enter | Legacy: same as Ctrl+J (LF) |
| Ctrl+J | Distinct (LF) | Distinct | Distinct | Distinct | Windows, Linux: taken (Toggle Panel). macOS: distinct | Distinct (LF) |
| Alt+Up | Not settled | Distinct | Linux: distinct. macOS: not settled | Distinct | Distinct; Windows, Linux: taken while the terminal is split | Distinct with one pane; taken when a pane lies above |
| Ctrl+Q | Distinct (no documented binding) | Distinct | Distinct | Distinct | Windows, macOS: taken (Quick Open View). Linux: not taken by the skip rule, untested | Distinct |
| Alt+Q | Composed character unless "Use Option as Meta key" | Composed character unless Option sends Esc+ | macOS: composed by default. Linux: distinct | macOS: distinct on U.S. layouts, composed on others. Linux: distinct | macOS: composed unless `macOptionIsMeta`. Windows, Linux: distinct | Distinct |
| Ctrl+N | Distinct (no documented binding) | Distinct | Distinct | Distinct | Distinct | Distinct |
| Ctrl+R | Distinct (no documented binding) | Distinct | Distinct | Distinct | Distinct; taken in accessibility mode | Distinct |
| Shift+Up | Not settled | Distinct | Distinct | Distinct; taken while text is selected | Distinct | Distinct |
| Ctrl+Up | Taken by macOS (Mission Control) | Taken by macOS | macOS: taken. Linux: distinct | macOS: taken. Linux: distinct | Taken on every OS (VS Code on Windows and Linux, macOS on Mac) | Distinct |
| Esc | Distinct after Ink's 20 ms wait | Distinct (`CSI 27 u`) | Distinct (`CSI 27 u`) | Distinct (`CSI 27 u`) | Distinct; taken while a notification toast shows | Distinct; after the 20 ms wait without kitty mode |

---

## 4. Detailed Findings

### 4.1 How the TUI reads keys

- **Raw mode.** Ink turns stdin to raw mode through Bun. On Linux and macOS, Bun's raw mode clears
  `IXON`, `ISIG` and `ICRNL` ([Bun `wtf-bindings.cpp` L156-L162](https://github.com/oven-sh/bun/blob/a28f3a40ed126ac2593c6e6c4b8e4fca0f277338/src/jsc/bindings/wtf-bindings.cpp#L156-L162)),
  so Ctrl+Q and Ctrl+S are not eaten by flow control, Ctrl+C sends no signal, and Enter stays CR,
  apart from Ctrl+J's LF. On Windows, Bun uses `UV_TTY_MODE_RAW_VT`, which makes the console send
  VT sequences itself instead of libuv translating key events
  ([Bun `source.rs` L539-L553](https://github.com/oven-sh/bun/blob/a28f3a40ed126ac2593c6e6c4b8e4fca0f277338/src/io/source.rs#L539-L553)).
- **Kitty query.** `renderTui` mounts Ink with `kittyKeyboard: { mode: "auto" }` and no flags
  ([`render.tsx` L51](../../packages/tui/src/render.tsx#L51),
  [L249-L250](../../packages/tui/src/render.tsx#L249-L250)). Ink then writes `CSI ? u`, waits up to
  200 ms for an answer, and on an answer pushes only `disambiguateEscapeCodes`, that is `CSI > 1 u`
  ([Ink `ink.js` lines 809, 861-866](https://unpkg.com/ink@7.1.1/build/ink.js)). Pi pushes flags 7
  and falls back to xterm `modifyOtherKeys` level 2 when the terminal does not answer
  ([Pi `terminal.ts` L19-L21, L416-L419](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/tui/src/terminal.ts#L19-L21));
  Ink has no such fallback.
- **CSI u is parsed whether or not the mode was negotiated.** `parseKeypress` tries the kitty
  `CSI codepoint ; modifiers u` form first on every input
  ([Ink `parse-keypress.js` lines 125, 383-389](https://unpkg.com/ink@7.1.1/build/parse-keypress.js)).
  A sequence a user maps in the terminal, such as Windows Terminal `sendInput` of `\u001b[13;3u`,
  therefore reaches the policy as Alt+Enter even in a terminal that never answered the query.
- **Kitty modifiers.** Ink folds kitty's Alt (2) and Meta (32) bits into `meta`, and keeps Shift and
  Ctrl ([`parse-keypress.js` lines 269-279](https://unpkg.com/ink@7.1.1/build/parse-keypress.js)).
  `CSI 13 ; m u` becomes `return` with those flags; `CSI 106 ; 5 u` becomes input `j` with `ctrl`
  ([lines 302-339](https://unpkg.com/ink@7.1.1/build/parse-keypress.js);
  [`use-input.js` lines 66-81](https://unpkg.com/ink@7.1.1/build/hooks/use-input.js)).
- **Legacy forms.** CR is `return`, ESC CR is `return` with `meta`, a lone LF is name `enter` and
  reaches the policy as input `"\n"`, a single control byte is Ctrl plus a letter, ESC plus a letter
  is `meta` plus the letter, and `CSI 1 ; m A` sets `meta` for xterm modifier bits 2 or 8, `shift`
  for 1 and `ctrl` for 4 ([`parse-keypress.js` lines 414-422, 447-451, 465-491](https://unpkg.com/ink@7.1.1/build/parse-keypress.js);
  [`use-input.js` lines 82-99](https://unpkg.com/ink@7.1.1/build/hooks/use-input.js)).
- **Esc versus Alt in legacy mode.** A lone ESC stays pending until another byte arrives or 20 ms
  pass ([`App.js` lines 45, 164-174](https://unpkg.com/ink@7.1.1/build/components/App.js);
  [`input-parser.js` lines 74-104](https://unpkg.com/ink@7.1.1/build/input-parser.js)). Esc pressed
  just before a key reads as Alt with that key, and Alt+Enter whose two bytes arrive more than
  20 ms apart (for example over SSH) reads as Esc then Enter. Pi hit the second case and added a
  configurable timeout ([Pi CHANGELOG L1272](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/CHANGELOG.md?plain=1#L1272)).
  Under kitty mode Esc is `CSI 27 u` and the ambiguity goes away.
- **What the policy does with the candidates today.** Shift+Enter, Alt+Enter, LF and Ctrl+`j` start
  a line ([`input.ts` L162-L170](../../packages/tui/src/input.ts#L162-L170)); Enter with `ctrl`
  submits, because only `shift` and `meta` count as a new line. Alt+Up goes to `routeEditingKey`,
  which checks `upArrow` without looking at `meta`, so it moves the cursor up today
  ([L193-L220](../../packages/tui/src/input.ts#L193-L220)). Any other key with `ctrl` or `meta`,
  Ctrl+Q and Alt+Q included, is dropped ([L147-L149](../../packages/tui/src/input.ts#L147-L149)).

### 4.2 What the kitty keyboard protocol changes

- With flag 1 the terminal reports Esc, Alt+key, Ctrl+key, Ctrl+Alt+key and Shift+Alt+key as
  `CSI u`, but "the Enter, Tab and Backspace keys" keep their legacy bytes so a shell stays usable
  after a crash ([spec, Disambiguate](https://sw.kovidgoyal.net/kitty/keyboard-protocol/#disambiguate);
  [`keyboard-protocol.rst` L353-L372](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/docs/keyboard-protocol.rst#L353-L372)).
  The spec does not say in words whether that exception covers a modified Enter. kitty's own encoder
  keeps plain CR only for unmodified Enter and sends `CSI 13 ; m u` once a modifier is held
  ([`key_encoding.c` L179-L231](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/key_encoding.c#L179-L231)),
  and xterm.js, which VS Code uses, does the same
  ([`KittyKeyboard.ts` L485-L503](https://github.com/xtermjs/xterm.js/blob/eefaadc7787f5b1c95c22867d02e4074e91f93c9/src/common/input/KittyKeyboard.ts#L485-L503)).
- In legacy mode Enter, Ctrl+Enter, Shift+Enter and Ctrl+Shift+Enter are all `0x0d`, and Alt+Enter
  is `0x1b 0x0d` ([spec C0 table, `keyboard-protocol.rst` L529-L533](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/docs/keyboard-protocol.rst#L529-L533)).
  Alt+key is ESC plus the key ([L562](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/docs/keyboard-protocol.rst#L562)),
  and legacy codes are ambiguous, for example Ctrl+M with Enter and Ctrl+R with Ctrl+Shift+R
  ([L580-L585](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/docs/keyboard-protocol.rst#L580-L585)).
- Arrows with modifiers are `CSI 1 ; m A` in both modes, so Alt+Up, Shift+Up and Ctrl+Up are distinct
  with or without the protocol once a terminal sends a modifier at all.
- The spec lists Ghostty, iTerm2, Microsoft Terminal and xterm.js among implementations
  ([`keyboard-protocol.rst` L35-L48](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/docs/keyboard-protocol.rst#L35-L48)).
  macOS Terminal is not listed.

### 4.3 Per terminal

#### macOS Terminal

- Not a kitty-protocol terminal (absent from the spec's list, section 4.2). A Pi issue measured
  Terminal.app sending `0x1b 0x0d` for Shift+Enter on one machine, which any parser reads as
  Alt+Enter ([earendil-works/pi#11559](https://github.com/earendil-works/pi/issues/11559)). Pi's docs
  say Terminal.app may send "plain Return or `ESC` + Return" for Shift+Enter and that Pi then reads
  the local Shift state through a native helper
  ([Pi `terminal-setup.md` L41-L45](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/terminal-setup.md?plain=1#L41-L45)).
- Apple's keyboard settings page only says that "Use Option as Meta key" makes Option act as Meta;
  it gives no default and does not list what Return, arrows or Ctrl keys send
  ([Apple, Change Profiles Keyboard settings](https://support.apple.com/guide/terminal/change-profiles-keyboard-settings-trmlkbrd/mac)).
- macOS itself takes Control-Up Arrow for Mission Control and Control-Down Arrow for an app's
  windows ([Apple, Use Mission Control](https://support.apple.com/guide/mac-help/use-mission-control-mh35798/mac)).
  This applies to every Mac terminal.

#### iTerm2

- Default profile: both Option keys "Normal", "Treat option as Alt" on, "Apps can change how keys
  are reported" enabled (`KEY_ALLOW_MODIFY_OTHER_KEYS`), and the libtickit `CSI u` mode off
  ([`iTermProfilePreferences.m` L1243-L1256](https://github.com/gnachman/iTerm2/blob/791d194a88f3bd8193399c6260c2f5e4d7ab715c/sources/Settings/iTermProfilePreferences.m#L1243-L1256)).
  The docs recommend Esc+ for Option and describe "Treat option as Alt for special keys like
  arrows" as reporting Option as Alt instead of Meta
  ([iTerm2 docs, Profiles > Keys](https://iterm2.com/documentation-preferences-profiles-keys.html)).
  So Option+Up arrives with the Alt bit; Option+Q composes a character unless Option is set to Esc+.
  The docs say nothing about Option+Return.
- Default key maps bind only Cmd+arrows, Cmd+Shift+Left/Right, Shift and Cmd with Page keys and
  Ctrl+Tab variants globally, and nothing per profile
  ([`DefaultGlobalKeyMap.plist`](https://github.com/gnachman/iTerm2/blob/791d194a88f3bd8193399c6260c2f5e4d7ab715c/plists/DefaultGlobalKeyMap.plist);
  [`DefaultBookmark.plist` L1064-L1066](https://github.com/gnachman/iTerm2/blob/791d194a88f3bd8193399c6260c2f5e4d7ab715c/plists/DefaultBookmark.plist#L1064-L1066)).
  None of the candidates is bound.
- Pi lists iTerm2 among terminals that tell modified Enter keys from Enter
  ([Pi `terminal-setup.md` L196](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/terminal-setup.md?plain=1#L196)).

#### kitty

- Speaks the protocol (it defines it). Default shortcuts use `kitty_mod`, which is Ctrl+Shift
  ([`definition.py` L3778-L3786](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/options/definition.py#L3778-L3786)):
  Ctrl+Shift+Enter new window, Ctrl+Shift+N new OS window, Ctrl+Shift+Q close tab, Ctrl+Shift+R
  resize window, Ctrl+Shift+Up scroll; on macOS Cmd+Enter, Cmd+N and Cmd+Q
  ([L3980-L3982](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/options/definition.py#L3980-L3982),
  [L4136-L4138](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/options/definition.py#L4136-L4138),
  [L4166-L4183](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/options/definition.py#L4166-L4183),
  [L4222-L4224](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/options/definition.py#L4222-L4224),
  [L4388-L4390](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/options/definition.py#L4388-L4390),
  [L4910-L4912](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/options/definition.py#L4910-L4912)).
  No candidate is bound.
- `macos_option_as_alt` defaults to `no`, which uses Option for Unicode input and, in the docs'
  words, "will break any Alt+Key keyboard shortcuts" in terminal programs
  ([L3533-L3550](https://github.com/kovidgoyal/kitty/blob/dd4ac51ad2f52a7859b41240e7f887010bf4210d/kitty/options/definition.py#L3533-L3550)).
  The option text is about keys that type characters; it does not say what Option+Enter or
  Option+Up send.

#### Ghostty

- Speaks the protocol (section 4.2). `macos-option-as-alt` defaults to true on the U.S. Standard and
  U.S. International layouts and false on others, and an Option sequence that produces no printable
  character "will be treated as Alt regardless" of the setting
  ([`Config.zig` L3501-L3533](https://github.com/ghostty-org/ghostty/blob/ec5925acf948c00f8204c420329f142f6e1471bb/src/config/Config.zig#L3501-L3533);
  rendered at [ghostty.org reference](https://ghostty.org/docs/config/reference#macos-option-as-alt)).
  So Option+Enter and Option+Up arrive as Alt on every layout, and Option+Q only on U.S. layouts.
- Default binds: Ctrl+Enter (Cmd+Enter on macOS) toggles full screen and Ctrl+Shift+Enter
  (Cmd+Shift+Enter) zooms a split
  ([L7131-L7141](https://github.com/ghostty-org/ghostty/blob/ec5925acf948c00f8204c420329f142f6e1471bb/src/config/Config.zig#L7131-L7141));
  on Linux Ctrl+Shift+N, Ctrl+Shift+Q and Ctrl+Shift+Up are new window, quit and jump to prompt
  ([L6850-L6865](https://github.com/ghostty-org/ghostty/blob/ec5925acf948c00f8204c420329f142f6e1471bb/src/config/Config.zig#L6850-L6865),
  [L7000-L7005](https://github.com/ghostty-org/ghostty/blob/ec5925acf948c00f8204c420329f142f6e1471bb/src/config/Config.zig#L7000-L7005)).
  Shift+Up adjusts a selection only when one exists, because the bind is `performable`
  ([L6800-L6805](https://github.com/ghostty-org/ghostty/blob/ec5925acf948c00f8204c420329f142f6e1471bb/src/config/Config.zig#L6800-L6805),
  [L1783-L1791](https://github.com/ghostty-org/ghostty/blob/ec5925acf948c00f8204c420329f142f6e1471bb/src/config/Config.zig#L1783-L1791)).
  On macOS Alt+Left/Right are rebound to `ESC b` and `ESC f`
  ([L7427-L7437](https://github.com/ghostty-org/ghostty/blob/ec5925acf948c00f8204c420329f142f6e1471bb/src/config/Config.zig#L7427-L7437)).
  Alt+Enter, Alt+Up, Alt+Q, Ctrl+Q, Ctrl+J, Ctrl+N and Ctrl+R have no default bind.

#### VS Code integrated terminal

- Before xterm.js sees a key, VS Code resolves it against its keybindings and keeps it when the
  command is in `terminal.integrated.commandsToSkipShell`, unless `sendKeybindingsToShell` is on
  ([VS Code docs, Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced);
  [`terminalInstance.ts` L1187-L1196](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts#L1187-L1196)).
  The default list includes `workbench.action.togglePanel` and `workbench.action.quickOpenView`
  ([`terminal.ts` L508, L651-L652](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/terminal/common/terminal.ts#L651-L652)).
  - Toggle Panel is Ctrl+J on Windows and Linux, Cmd+J on macOS
    ([`panelActions.ts` L51](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/browser/parts/panel/panelActions.ts#L51)).
  - Quick Open View is Ctrl+Q on Windows and macOS, unbound on Linux
    ([`viewQuickAccess.ts` L249-L253](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/quickaccess/browser/viewQuickAccess.ts#L249-L253)).
    On Linux Ctrl+Q is Quit
    ([`desktop.contribution.ts` L72-L90](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/electron-browser/desktop.contribution.ts#L72-L90)),
    which is not on the skip list.
  - Focus Previous Terminal in Terminal Group is Alt+Left and Alt+Up on Windows and Linux, only
    while a split terminal is active
    ([`terminalActions.ts` L407-L418](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/terminal/browser/terminalActions.ts#L407-L418)).
  - Scroll To Previous Command is Ctrl+Up (Cmd+Up on macOS) whenever the terminal has focus and
    accessibility mode is off
    ([L876-L881](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/terminal/browser/terminalActions.ts#L876-L881)).
  - Ctrl+R runs a recent command only in accessibility mode
    ([`terminal.history.contribution.ts` L162-L166](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/terminalContrib/history/browser/terminal.history.contribution.ts#L162-L166)).
  - Escape hides a visible notification toast
    ([`notificationsCommands.ts` L238-L243](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/browser/parts/notifications/notificationsCommands.ts#L238-L243)),
    and `notifications.hideToasts` is on the skip list.
- Alt keys go to the shell, because menu mnemonics are off by default
  (`terminal.integrated.allowMnemonics`, which "does nothing on macOS")
  ([VS Code docs, Terminal Advanced](https://code.visualstudio.com/docs/terminal/advanced)).
  On macOS, `terminal.integrated.macOptionIsMeta` defaults to false
  ([`terminalConfiguration.ts` L144-L148](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts#L144-L148)),
  and xterm.js then sends no ESC for Option+letter
  ([`Keyboard.ts` L333-L334](https://github.com/xtermjs/xterm.js/blob/eefaadc7787f5b1c95c22867d02e4074e91f93c9/src/common/input/Keyboard.ts#L333-L334)).
  Enter and arrows still carry Alt: legacy Alt+Enter is ESC CR and Alt+Up is `CSI 1 ; 3 A` on every
  platform, while Ctrl+Enter and Shift+Enter are plain CR
  ([L100-L110, L145-L156](https://github.com/xtermjs/xterm.js/blob/eefaadc7787f5b1c95c22867d02e4074e91f93c9/src/common/input/Keyboard.ts#L100-L156)).
- `terminal.integrated.enableKittyKeyboardProtocol` defaults to true
  ([`terminalConfiguration.ts` L616-L622](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts#L616-L622));
  the 1.109 notes say the protocol "will be rolling out to stable this release"
  ([VS Code 1.109 release notes](https://code.visualstudio.com/updates/v1_109)). Pi's docs date the
  default to 1.109.5
  ([Pi `terminal-setup.md` L131-L133](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/terminal-setup.md?plain=1#L131-L133)).
  Win32 input mode stays off by default
  ([L623-L631](https://github.com/microsoft/vscode/blob/742a9ae378720f2526ed7128fbc47ec2a285f1b1/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts#L623-L631)).

#### Windows Terminal

- Default actions: Alt+Enter and F11 toggle full screen; Alt+arrows move pane focus; Alt+Shift+arrows
  resize panes; Ctrl+Shift+N, Ctrl+Shift+T and Ctrl+Shift+W open a window, open a tab and close a
  pane; Ctrl+Shift+Up scrolls
  ([learn.microsoft.com, Windows Terminal Actions](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/actions);
  [`defaults.json` L700-L767](https://github.com/microsoft/terminal/blob/cf5e6bf22727a251aced8bc30491c87428a4e116/src/cascadia/TerminalSettingsModel/defaults.json#L700-L767)).
  No Ctrl+Q, Ctrl+N, Ctrl+R, Ctrl+J, Ctrl+Up, Shift+Up or Alt+Q default exists.
- Full screen always marks the key handled. Move focus marks it handled only when the focus moved,
  "so the keychord can propagate to the terminal" when there is no pane in that direction
  ([`AppActionHandlers.cpp` L511-L530, L620-L625](https://github.com/microsoft/terminal/blob/cf5e6bf22727a251aced8bc30491c87428a4e116/src/cascadia/TerminalApp/AppActionHandlers.cpp#L511-L530)).
  An `unbound` or `null` entry passes a key to the shell, and `sendInput` can send any sequence
  ([learn.microsoft.com, Unbind keys and sendInput](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/actions)).
- Legacy encoding, shared with conhost: Enter is CR, Ctrl+Enter is LF "because that's the expected
  behavior for most PC keyboard layouts", and Alt adds an ESC prefix
  ([`terminalInput.cpp` L939-L966, L1188-L1191](https://github.com/microsoft/terminal/blob/cf5e6bf22727a251aced8bc30491c87428a4e116/src/terminal/input/terminalInput.cpp#L939-L966)).
  Shift+Enter is therefore plain Enter, and Ctrl+Enter is the TUI's Ctrl+J.
- The kitty protocol shipped in Preview 1.25.622.0 and stable 1.25.2733.0, and can be turned off in
  Settings ([v1.25.622.0 notes](https://github.com/microsoft/terminal/releases/tag/v1.25.622.0),
  [v1.25.2733.0 notes](https://github.com/microsoft/terminal/releases/tag/v1.25.2733.0),
  [microsoft/terminal#19817](https://github.com/microsoft/terminal/pull/19817)). The PR also
  changes conhost's `VtIo.cpp`, but no doc says that a native Windows process reading VT input
  behind ConPTY receives kitty reports.

### 4.4 What Pi binds, and why

Snapshot: Pi `main` at
[`69a6993`](https://github.com/earendil-works/pi/commit/69a6993486acee850d14a4a1547daa4a167228ad).

| Action | Pi default | On Windows and WSL | Source |
| :--- | :--- | :--- | :--- |
| Submit | `enter` | same | [tui `keybindings.ts` L143-L144](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/tui/src/keybindings.ts#L143-L144) |
| New line | `shift+enter`, `ctrl+j` | same | same lines |
| Interrupt | `escape` | same | [`keybindings.ts` L26](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/keybindings.ts#L26) |
| Queue Follow-up | `alt+enter` | `ctrl+q` | [L67-L70](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/keybindings.ts#L67-L70) |
| Restore queued messages | `alt+up` | `alt+q` | [L71-L74](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/keybindings.ts#L71-L74) |
| New Session, resume picker, tree, fork | none (`/new`, `/resume`, `/tree`, `/fork`) | none | [L79-L82](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/keybindings.ts#L79-L82); [`keybindings.md` L137-L140](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/keybindings.md?plain=1#L137-L140) |
| Inside the resume picker | `ctrl+n` named filter, `ctrl+r` rename, `ctrl+s` sort, `ctrl+d` delete | same | [L55-L58, L99-L114](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/keybindings.ts#L99-L114) |
| Enter the queue to select items | no such action | none | [`keybindings.md` L160-L167](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/keybindings.md?plain=1#L160-L167) |

Pi's reasons:

- **Windows means native Windows or WSL.** `useWindowsKeybindings` is true for `win32`, and for
  Linux when `WSL_DISTRO_NAME` or `WSL_INTEROP` is set
  ([`keybindings.ts` L16-L21](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/keybindings.ts#L16-L21)).
  The issue that asked for it argues that Windows Terminal is the common terminal for both
  ([earendil-works/pi#8372](https://github.com/earendil-works/pi/issues/8372)).
- **Ctrl+Q for Follow-up:** Windows Terminal binds Alt+Enter to full screen, so the key never
  reaches Pi ([Pi `terminal-setup.md` L186-L190](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/terminal-setup.md?plain=1#L186-L190)).
  The issue's table gives "WT keybinding for fullscreen, eaten" and says the choice of Ctrl+Q "is
  motivated by how GHC CLI does it" ([#8372](https://github.com/earendil-works/pi/issues/8372)).
- **Alt+Q for restore:** Pi states only the general reason: the defaults avoid "terminal-reserved
  shortcuts" for, among others, message queueing
  ([Pi CHANGELOG L1166](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/CHANGELOG.md?plain=1#L1166);
  commit [`27b7a62`](https://github.com/earendil-works/pi/commit/27b7a626de0e36845feb0c21d6da77352dd4834a)).
  The matching reservation is Windows Terminal's Alt+Up move-focus default (section 4.3); Pi does
  not name it, and does not mention that move focus passes the key through with a single pane.
- **Shift+Enter fallback:** on native Windows and in Apple Terminal, Pi reads the local Shift state
  and treats CR or ESC CR as Shift+Enter while Shift is held; this does not work over SSH or in WSL
  ([Pi `terminal-setup.md` L41-L45, L171-L173](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/docs/terminal-setup.md?plain=1#L171-L173);
  [CHANGELOG L270](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/CHANGELOG.md?plain=1#L270)).

---

## 5. Implications for CDA-144

Candidates per action, with the caveats from sections 3 and 4. No choice is made here.

**Queue a Follow-up**

- *Alt+Enter.* Distinct in kitty on Linux, Ghostty and VS Code, and anywhere the kitty protocol is
  on. Taken by Windows Terminal. Not settled on macOS Terminal, iTerm2 and kitty on macOS with
  default Option settings. In legacy mode it is ESC CR, so a split arrival reads as Esc then Enter;
  under the Stage 1 plan that would cancel and send a Steer. The Terminal.app report of ESC CR for
  Shift+Enter would queue a Follow-up where the person meant a line break.
- *Ctrl+Q.* No terminal default binds it (macOS Terminal documents none) and Bun clears `IXON`, so
  flow control does not eat it, but VS Code takes it on Windows and macOS for Quick Open View unless the user changes `commandsToSkipShell`. Pi's Windows
  default has the same conflict inside VS Code on Windows.
- *Ctrl+Enter.* Distinct only under the kitty protocol. Legacy Windows Terminal turns it into LF,
  which the TUI reads as Ctrl+J, and Ghostty on Linux takes it for full screen.

**Insert a line break once Alt+Enter queues**

- *Shift+Enter* needs the kitty protocol, or Pi's native Shift-state helper; it is plain Enter in
  macOS Terminal and in Windows Terminal without kitty mode.
- *Ctrl+J* is LF in every legacy terminal and `CSI 106 ; 5 u` under kitty, but VS Code takes it on
  Windows and Linux. If kitty mode does not reach a native Windows process in VS Code, that setup is
  left with no line-break key (Shift+Enter is CR, Ctrl+J is taken, Ctrl+Enter is CR).

**Pull the queue back into the Prompt**

- *Alt+Up.* Distinct in iTerm2, Ghostty, kitty on Linux and VS Code; Windows Terminal takes it only
  when a pane lies above, VS Code on Windows and Linux only while the terminal is split. The policy
  must check `meta` before `routeEditingKey`, which moves the cursor on any Up today.
- *Alt+Q.* A Windows and Linux candidate only: on macOS, Option+Q composes a character by default in
  macOS Terminal, iTerm2, kitty and VS Code, and in Ghostty on non-U.S. layouts.

**Start a new Session**

- *Ctrl+N.* No default binding in any of the six (macOS Terminal documents none). In legacy mode it
  equals Ctrl+Shift+N, which kitty, Ghostty on Linux and Windows Terminal use for a new window, so
  a person who adds Shift gets a window instead. Bash binds Ctrl+N to next history
  ([Bash manual, Commands For History](https://www.gnu.org/software/bash/manual/html_node/Commands-For-History.html)),
  which would clash if the Prompt gains history. Pi binds Ctrl+N inside its resume picker, not
  globally.
- *A slash command* such as Pi's `/new`, with no default key.

**Open the resume list**

- *Ctrl+R.* No default binding in any of the six except VS Code in accessibility mode (macOS
  Terminal documents none). Bash binds it to reverse history search
  ([Bash manual, Commands For History](https://www.gnu.org/software/bash/manual/html_node/Commands-For-History.html)),
  so it would clash if the Prompt later gains history search. Pi uses Ctrl+R to rename inside its
  picker.
- *A slash command* such as Pi's `/resume`.

**Enter the Prompt Queue (queue selection mode)**

- *Up while the Prompt is empty, or on its first row.* Plain Up is distinct everywhere; the policy
  needs the condition because Up moves between Prompt rows today.
- *Shift+Up.* Distinct in all six except while Ghostty has a selection; macOS Terminal not settled.
- *Ctrl+Up.* Taken by macOS on every Mac terminal and by VS Code on Windows and Linux.
- *Alt+Up,* if restore moves to another key.

**Esc** stays distinct everywhere; legacy terminals add Ink's 20 ms wait, and VS Code keeps it
while a notification toast shows.

**Cross-cutting**

- Platform defaults: Pi keys its Windows set off native Windows and WSL, because the terminal there
  is usually Windows Terminal. `process.platform` alone reports `linux` in WSL.
- A person can always map a chord in the terminal to a `CSI u` sequence (Windows Terminal
  `sendInput`, VS Code `sendSequence`); Ink parses it even without kitty mode.
- Ink asks for flag 1 only and has no `modifyOtherKeys` fallback, unlike Pi.

---

## 6. What the Sources Do Not Settle

- Whether a native Windows process (Bun with VT input) behind ConPTY gets kitty reports in Windows
  Terminal 1.25 and later, or in VS Code on Windows. This decides whether Shift+Enter works there.
- What macOS Terminal sends by default for Option+Return, Option+Up, Shift+Up and Ctrl+Enter. The
  only measurement found is Pi issue #11559, and that report gives both ESC CR and ESC LF for
  Shift+Enter.
- What iTerm2 (Option "Normal") and kitty on macOS (`macos_option_as_alt no`) send for Option+Return
  and Option+Up, and what iTerm2 and Ghostty on macOS send for Ctrl+Enter.
- Whether Ctrl+Q reaches the terminal in VS Code on Linux. The skip rule says yes, because Quit is
  not on the list, but this was not tested.
- tmux, SSH and other terminals were out of scope.

A key-echo screen in the CDA-144 prototype, or `kitten show-key`, run once per terminal, would
settle these.

---

## 7. Primary Sources & Snapshot Notes

Pinned revisions read on 2026-11-23:

- **This repository**: [`packages/tui/src/input.ts`](../../packages/tui/src/input.ts),
  [`packages/tui/src/render.tsx`](../../packages/tui/src/render.tsx),
  [`packages/tui/CONTEXT.md`](../../packages/tui/CONTEXT.md).
- **Ink 7.1.1** (the version in `packages/tui/package.json`), built files:
  [`parse-keypress.js`](https://unpkg.com/ink@7.1.1/build/parse-keypress.js),
  [`hooks/use-input.js`](https://unpkg.com/ink@7.1.1/build/hooks/use-input.js),
  [`input-parser.js`](https://unpkg.com/ink@7.1.1/build/input-parser.js),
  [`components/App.js`](https://unpkg.com/ink@7.1.1/build/components/App.js),
  [`ink.js`](https://unpkg.com/ink@7.1.1/build/ink.js),
  [`kitty-keyboard.js`](https://unpkg.com/ink@7.1.1/build/kitty-keyboard.js).
- **Bun** at [`a28f3a4`](https://github.com/oven-sh/bun/tree/a28f3a40ed126ac2593c6e6c4b8e4fca0f277338).
- **kitty keyboard protocol**: [spec](https://sw.kovidgoyal.net/kitty/keyboard-protocol/), source
  and encoder at kitty [`dd4ac51`](https://github.com/kovidgoyal/kitty/tree/dd4ac51ad2f52a7859b41240e7f887010bf4210d).
- **Ghostty** at [`ec5925a`](https://github.com/ghostty-org/ghostty/tree/ec5925acf948c00f8204c420329f142f6e1471bb);
  [config reference](https://ghostty.org/docs/config/reference).
- **iTerm2**: [Profiles > Keys docs](https://iterm2.com/documentation-preferences-profiles-keys.html);
  source at [`791d194`](https://github.com/gnachman/iTerm2/tree/791d194a88f3bd8193399c6260c2f5e4d7ab715c).
- **macOS Terminal**: [Keyboard settings](https://support.apple.com/guide/terminal/change-profiles-keyboard-settings-trmlkbrd/mac);
  [Mission Control](https://support.apple.com/guide/mac-help/use-mission-control-mh35798/mac).
- **VS Code**: [Terminal Advanced docs](https://code.visualstudio.com/docs/terminal/advanced);
  [1.109 release notes](https://code.visualstudio.com/updates/v1_109); source at
  [`742a9ae`](https://github.com/microsoft/vscode/tree/742a9ae378720f2526ed7128fbc47ec2a285f1b1);
  xterm.js at [`eefaadc`](https://github.com/xtermjs/xterm.js/tree/eefaadc7787f5b1c95c22867d02e4074e91f93c9).
- **Windows Terminal**: [Actions docs](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/actions);
  source at [`cf5e6bf`](https://github.com/microsoft/terminal/tree/cf5e6bf22727a251aced8bc30491c87428a4e116);
  release notes [v1.25.622.0](https://github.com/microsoft/terminal/releases/tag/v1.25.622.0) and
  [v1.25.2733.0](https://github.com/microsoft/terminal/releases/tag/v1.25.2733.0).
- **Pi** at [`69a6993`](https://github.com/earendil-works/pi/tree/69a6993486acee850d14a4a1547daa4a167228ad);
  issues [#8372](https://github.com/earendil-works/pi/issues/8372) and
  [#11559](https://github.com/earendil-works/pi/issues/11559).
