# CDA-135: Research Claude Code's `--worktree` behaviour

## Question

How does Claude Code's `--worktree [name]` behave? This covers where the worktree is created, the
branch name and the base it branches from, the name generated when none is given, what happens
outside a git repository, what happens to the worktree on exit (kept or removed, with and without
changes), and how a resumed session finds its worktree again.

The answer feeds CDA-143 ("Decide worktree location, branch name, cleanup, and how worktree
Sessions are listed and resumed"). The planned feature, taken from Claude Code, is
`coding-agent --worktree [name]`: open a Session in its own git worktree, generate a name when none
is given, report a clear error outside a git repository, resume a worktree Session inside its
worktree while the worktree still exists, and run several terminals in parallel with `--worktree`.

## Short answer

- **Location and branch.** `claude --worktree <name>` creates the worktree at
  `<repository root>/.claude/worktrees/<name>/` on a new branch `worktree-<name>`, and starts the
  session in it.
- **Base.** The branch starts from the remote default branch (`origin/HEAD`), fetched if older than
  24 hours, and falls back to local `HEAD` when there is no usable remote. The setting
  `worktree.baseRef: "head"` switches the base to local `HEAD`. A branch name cannot be given as the
  base, but `--worktree "#123"` or a PR/MR URL branches from that pull request into `pr-<number>`.
- **No name.** Claude Code generates one. The docs give `bright-running-fox` and `bold-oak-a3f2` as
  examples but do not specify the format.
- **Outside git.** Claude Code exits with `Can only use --worktree in a git repository`, unless a
  `WorktreeCreate` hook is configured. That hook replaces git entirely, which is how SVN, Perforce
  or Mercurial are supported.
- **On exit.** Only interactive sessions clean up. A clean worktree of an unnamed session is
  removed with its branch without asking. A named session, a worktree with changes, untracked files
  or new commits, and a worktree whose state cannot be verified all prompt keep or remove. A
  worktree another session is using is always kept. Keeping prints a
  `claude --worktree <name> --resume` command. `-p` runs never clean up.
- **Resume.** The session's transcript moves to the worktree directory and the session keeps a
  worktree binding. On resume, Claude Code re-enters the worktree after checking it is still a
  separate checkout. If the directory is gone, the session resumes in the launch directory and the
  binding is cleared. The picker shows the current worktree's sessions and widens to all worktrees
  of the repository with `Ctrl+W`. Passing the same name to `--worktree` again reopens the existing
  worktree.

## Research basis

All retrievals were made on **2026-11-23** against Claude Code **2.1.330**, which is both the
version installed on the researching machine (`claude --version`) and the top entry of the
CHANGELOG at that date. Documentation pages were read as their raw Markdown
(`https://code.claude.com/docs/en/<page>.md`); citations below use the rendered page URLs.

- [Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees): the main
  source, a page dedicated to `--worktree`.
- [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags): `--worktree`, `--tmux`,
  `--resume`.
- [Manage sessions](https://code.claude.com/docs/en/sessions): session picker, resume by ID or
  name, session names, transcript storage.
- [Hooks reference](https://code.claude.com/docs/en/hooks#worktreecreate): `WorktreeCreate` and
  `WorktreeRemove`.
- [Settings reference](https://code.claude.com/docs/en/settings-reference#worktree): the
  `worktree.*` keys.
- [Common workflows](https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees),
  [Tools reference](https://code.claude.com/docs/en/tools-reference#enterworktree-tool-behavior),
  [Status line](https://code.claude.com/docs/en/statusline), and
  [Desktop](https://code.claude.com/docs/en/desktop#run-a-session-in-its-own-worktree) for
  supporting details.
- [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) in
  `anthropics/claude-code`, cited by version number.
- `claude --help` (2.1.330) lists `-w, --worktree [name]` as "Create a git worktree for this
  session (optionally named)".

Claude Code is closed source, so behaviour the docs and CHANGELOG do not describe could not be
checked against code. No worktree or session was created for this research.

## Findings

### 1. Where the worktree is created

- By default the worktree goes under `.claude/worktrees/<name>/` at the repository root, and the
  session starts in it
  ([worktrees](https://code.claude.com/docs/en/worktrees#start-claude-in-a-worktree);
  [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags) gives
  `<repo>/.claude/worktrees/<name>`).
- Claude Code does not ignore that directory for you. The docs only advise adding
  `.claude/worktrees/` to `.gitignore` so worktree contents do not show up as untracked files in
  the main checkout ([worktrees](https://code.claude.com/docs/en/worktrees#start-claude-in-a-worktree)).
  Nothing in the docs or CHANGELOG says Claude Code edits `.gitignore` itself.
- The CLI has no setting to move `--worktree` worktrees elsewhere. `worktree.location` exists but
  only the desktop app reads it for SSH sessions; `--worktree` ignores it
  ([settings reference](https://code.claude.com/docs/en/settings-reference#worktree-location)). The
  desktop app has its own "Worktree location" setting for local sessions
  ([desktop](https://code.claude.com/docs/en/desktop#run-a-session-in-its-own-worktree)). On the CLI,
  the only way to place worktrees elsewhere is a `WorktreeCreate` hook that returns another path
  ([worktrees](https://code.claude.com/docs/en/worktrees#replace-worktree-creation-with-a-hook)).
- Claude Code refuses to create a worktree when `.claude`, `.claude/worktrees` or the worktree
  directory is a symlink. Before 2.1.212 a committed symlink at one of those paths could make it
  write outside the repository
  ([worktrees](https://code.claude.com/docs/en/worktrees#troubleshooting); CHANGELOG 2.1.212).
- A worktree is a fresh checkout, so gitignored files such as `.env` are missing. A
  `.worktreeinclude` file at the project root (gitignore syntax) lists gitignored files to copy in;
  only files that match and are gitignored are copied
  ([worktrees](https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees)).
  `worktree.symlinkDirectories` symlinks large directories such as `node_modules` from the main
  repository, and `worktree.sparsePaths` checks out only listed directories through git
  sparse-checkout
  ([settings reference](https://code.claude.com/docs/en/settings-reference#worktree-symlinkdirectories)).
- Some state stays shared with the main checkout: the `.git` directory, project-scope plugins,
  "don't ask again" permission approvals (saved to the main checkout's
  `.claude/settings.local.json`), and untracked skills, agents and commands when the worktree has
  no copy of its own
  ([worktrees](https://code.claude.com/docs/en/worktrees#what-worktrees-share-with-the-main-checkout)).

### 2. Branch name and base

- The new branch is named `worktree-<name>`
  ([worktrees](https://code.claude.com/docs/en/worktrees#start-claude-in-a-worktree)). The status
  line's `worktree.branch` field shows the same shape, for example `worktree-my-feature`
  ([status line](https://code.claude.com/docs/en/statusline)). The CLI has no branch-prefix setting;
  the desktop app has a "Branch prefix" setting it prepends to worktree branch names
  ([desktop](https://code.claude.com/docs/en/desktop#run-a-session-in-its-own-worktree)).
- The base is set by `worktree.baseRef`
  ([worktrees](https://code.claude.com/docs/en/worktrees#choose-the-base-branch);
  [settings reference](https://code.claude.com/docs/en/settings-reference#worktree-baseref)):
  - `"fresh"` (default) branches from `origin/<default-branch>`, so the worktree starts from a tree
    matching the remote.
  - `"head"` branches from the current local `HEAD`, carrying unpushed commits. Inside a linked
    worktree it resolves to that worktree's `HEAD`.
  - A branch name is not accepted. To start from an existing branch, the docs say to create the
    worktree with `git worktree add` and start Claude Code in it.
- For `"fresh"`, Claude Code fetches the default branch when the repository has not been fetched in
  24 hours, capped at five seconds, and uses the cached ref if the fetch fails. The fetch never
  waits for input: a password, passphrase or new-host prompt counts as a failure. With no remote,
  or no cached and fetchable `origin/HEAD`, the base falls back to local `HEAD`
  ([worktrees](https://code.claude.com/docs/en/worktrees#choose-the-base-branch)).
- The default has moved over time. `worktree.baseRef` arrived in 2.1.133 with `"fresh"` as default;
  from 2.1.128 to 2.1.133 the in-session `EnterWorktree` tool used local `HEAD`
  (CHANGELOG 2.1.128, 2.1.133).
- Passing `#<number>`, a GitHub PR URL or a GitLab MR URL fetches that change's head commit from
  `origin` and creates the worktree at `.claude/worktrees/pr-<number>`. A fetch that would prompt
  fails with `Error creating worktree: Failed to fetch PR/MR #<number>`
  ([worktrees](https://code.claude.com/docs/en/worktrees#branch-from-a-pull-request)). The docs do
  not name the branch created for a PR worktree.

### 3. Name generated when none is given

- If the name is omitted, "Claude generates one such as `bright-running-fox`"
  ([worktrees](https://code.claude.com/docs/en/worktrees#start-claude-in-a-worktree);
  [CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags)).
- The `WorktreeCreate` hook input describes `name` as a slug, "either specified by the user or
  auto-generated", with the example `bold-oak-a3f2`
  ([hooks](https://code.claude.com/docs/en/hooks#worktreecreate-input)).
- The two examples have different shapes (three words versus two words and a hex suffix). The docs
  do not specify the format, the word lists, or how a generated name avoids collisions.
- Name validation is not documented either. CHANGELOG 2.1.83 fixed `--worktree` "hanging silently
  when the worktree name contained a forward slash", which shows names reach both a directory and a
  branch name, but not what is now accepted.

### 4. Outside a git repository

- With no `WorktreeCreate` hook, `--worktree` outside a git checkout fails with
  `Can only use --worktree in a git repository`. The documented recoveries are: `git init` plus a
  first commit, a hook for another version control system, or starting without `--worktree`
  ([worktrees](https://code.claude.com/docs/en/worktrees#troubleshooting)).
- A git repository with no commits is not enough: a worktree is created from an existing commit, "so
  the repository needs at least one commit first"
  ([common workflows](https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees)).
  The exact error for that case is not documented.
- A `WorktreeCreate` hook replaces the git logic entirely. It receives `name` on stdin and prints
  the created directory's path as the last stdout line (command hook) or returns `worktreePath`
  (HTTP hook). `.worktreeinclude` is then not processed. A paired `WorktreeRemove` hook receives
  `worktree_path` and does the cleanup
  ([worktrees](https://code.claude.com/docs/en/worktrees#non-git-version-control);
  [hooks](https://code.claude.com/docs/en/hooks#worktreecreate)). Since 2.1.85 the hook can run in a
  non-git directory instead of `--worktree` failing first (CHANGELOG 2.1.85).
- Claude Code never deletes a branch of a hook-created worktree, because it only knows the returned
  path. Its change detection uses git, so it sees no changes in a non-git worktree even when there
  is uncommitted work; the docs tell the `WorktreeRemove` hook to check for that itself
  ([hooks](https://code.claude.com/docs/en/hooks#worktreeremove)).
- Separately, an interactive `--worktree` run requires workspace trust for the directory; without
  it, Claude Code exits with an error asking you to run `claude` there once. `-p` skips the check
  ([worktrees](https://code.claude.com/docs/en/worktrees#start-claude-in-a-worktree)).

### 5. What happens to the worktree on exit

When an interactive worktree session exits, Claude Code checks for work that removal would delete:
changed or untracked files, uncommitted work in checked-out submodules, and new commits. Then
([worktrees](https://code.claude.com/docs/en/worktrees#clean-up-worktrees)):

| Situation at exit | Outcome |
|---|---|
| Another Claude Code session is in the worktree | Kept, with its branch, even if you choose removal; a `Worktree kept at` message says so |
| Clean, session not named | Worktree and branch removed automatically, no prompt |
| Clean, session named | Prompt to keep or remove |
| Has changes, untracked files or new commits | Prompt. Keep preserves directory and branch and prints `claude --worktree <name> --resume`. Remove deletes the directory, the branch and all the work in them |
| Another branch with commits past the starting commit is checked out | Prompt. Either answer keeps that other branch; removal deletes the directory and the worktree's own branch |
| State cannot be verified (changes or submodules) | Prompt, naming what could not be checked |

Notes on these rules:

- "Named" links to session naming (`claude -n`, `/rename`)
  ([sessions](https://code.claude.com/docs/en/sessions#name-your-sessions)), and the
  `WorktreeRemove` docs repeat "a session you haven't named"
  ([hooks](https://code.claude.com/docs/en/hooks#worktreeremove)). The docs do not say whether the
  name given to `--worktree` itself counts as naming the session.
- Non-interactive `-p` runs have no exit prompt, so their worktrees are never cleaned up and the
  lock Claude Code took at creation stays until a later session's stale-lock sweep releases it.
  Manual removal is `git worktree unlock` then `git worktree remove`
  ([worktrees](https://code.claude.com/docs/en/worktrees#clean-up-worktrees)).
- Several fixes show where this logic went wrong: removal without asking when `HEAD` was detached or
  on another branch, which could lose commits (2.1.304); deleting a worktree another running session
  was using (2.1.330); exit not saying a worktree was kept (2.1.327). Since 2.1.143, cleanup no
  longer falls back to `rm -rf` when `git worktree remove` fails, "preventing loss of gitignored or
  in-progress files" (CHANGELOG).
- The printed resume command shortens to `-w` and `-r` when the long flags do not fit the terminal
  (CHANGELOG 2.1.299).
- A `--worktree` session moved to the background becomes subject to a periodic sweep that removes
  Claude-created worktrees older than `cleanupPeriodDays` (default 30) unless they still hold work,
  are locked by a running session, or were created by the user with `git worktree add`. Claude Code
  marks worktrees it creates in their git metadata so the sweep can tell them apart. A foreground
  `--worktree` worktree that was never backgrounded is never swept
  ([worktrees](https://code.claude.com/docs/en/worktrees#clean-up-subagent-and-background-session-worktrees)).

### 6. How a resumed session finds its worktree again

- **The transcript follows the worktree.** Transcripts live at
  `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is the working directory path
  with non-alphanumeric characters replaced by `-`
  ([sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)). When a session
  enters or exits a git worktree Claude Code created, Claude Code records the session under the new
  working directory, so `--resume` finds it there. A hook-created worktree keeps its transcript at
  the launch directory
  ([worktrees](https://code.claude.com/docs/en/worktrees#resume-a-worktree-session)).
- **The session keeps a worktree binding.** Resuming a session that ended isolated in its worktree,
  without exiting it, returns the session there and keeps it isolated. This holds for interactive
  resumes, for `-p` with `--continue` or `--resume`, and for the Agent SDK (since 2.1.212 for
  non-interactive resumes)
  ([worktrees](https://code.claude.com/docs/en/worktrees#resume-a-worktree-session)).
- **Verification before re-entry.** Claude Code first checks from the worktree's git metadata that
  it is still a checkout separate from the main one, and declines one that fails.
- **Launch directory matters.**
  - `--resume` from the main checkout or another directory of the repository works. A worktree
    Claude Code created under `.claude/worktrees/` is re-entered even when launching from inside it.
  - `--continue` picks the most recent session recorded under the launch directory.
  - `--fork-session` starts the fork in the launch directory and leaves the original worktree alone.
- **Deleted worktree.** If the directory no longer exists, the session resumes in the launch
  directory, Claude Code says the worktree is gone, and it clears the binding.
- **Interactive failure messages.** These start with `Your worktree <path> no longer exists`,
  `Could not verify your worktree <path> this time` (binding kept), `Did not re-enter your worktree
  <path>` (unsafe, binding cleared) or `Could not re-enter your worktree <path>` (binding kept). In
  `-p` and SDK resumes, every refusal except a gone worktree stops the resume with an error instead
  of continuing unisolated
  ([worktrees](https://code.claude.com/docs/en/worktrees#the-session-resumes-outside-its-worktree)).
- **Listing.**
  - The session picker shows the current worktree's sessions by default; `Ctrl+W` widens it to all
    worktrees of the repository and `Ctrl+A` to every project.
  - A session picked from another worktree of the same repository resumes in place; one whose
    worktree is gone resumes in the current directory.
  - `--resume <id>` searches the current project and its git worktrees, then every other project.
  - `--resume <name>` resolves across the repository and its worktrees
    ([sessions](https://code.claude.com/docs/en/sessions#where-the-session-picker-looks)).
- **Reusing a name reopens the worktree.** Passing an existing name to `--worktree` opens that
  worktree instead of creating one. With the `"fresh"` base, a reopened worktree resets to the
  default branch when it is clean, still on its own branch, and has no commits of its own (or its
  PR was merged and the remote branch deleted); otherwise it reopens at its old tip
  ([worktrees](https://code.claude.com/docs/en/worktrees#reuse-a-worktree-name)). The printed
  `claude --worktree <name> --resume` command appears to rely on this reopening; the docs do not
  say so in one place.

### 7. Parallel terminals and isolation

- Parallel work is one `claude --worktree <name>` per terminal, each with a different name
  ([worktrees](https://code.claude.com/docs/en/worktrees#start-claude-in-a-worktree);
  [common workflows](https://code.claude.com/docs/en/common-workflows#run-parallel-sessions-with-worktrees)).
  `--tmux` (requires `--worktree`) creates a tmux session or iTerm2 panes for the worktree
  ([CLI reference](https://code.claude.com/docs/en/cli-reference#cli-flags)).
- A session started with `--worktree` but not `--tmux` is "isolated". Claude Code then blocks
  `Edit`/`Write` to paths in the main checkout, commands whose working directory resolves there,
  git redirected there (`git -C`, `--git-dir`, `GIT_DIR`, `GIT_WORK_TREE`, `cd`), and commands whose
  git usage it cannot verify from the text. It does not track files a shell command writes, so `cp`
  or a redirect into the main checkout is not caught by these checks
  ([worktrees](https://code.claude.com/docs/en/worktrees#how-claude-code-enforces-isolation)).

## Where the sources are silent

- The format and collision handling of generated names (two different documented examples).
- Which characters a worktree name may contain.
- The branch name for a `#<number>` or PR/MR URL worktree.
- Whether `--worktree <name>` counts as naming the session for the clean-exit auto-removal rule.
- The error shown for a git repository with no commits.
- Where a new worktree goes when `--worktree` is launched from inside a linked worktree. The docs
  say "at your repository root"; CHANGELOG 2.1.157 fixed `--worktree` "returning to the canonical
  repo root instead of the current linked worktree", which suggests the current linked worktree is
  the reference point, but the docs do not say so.
- How the worktree binding is stored. The transcript format is internal and "changes between
  versions" ([sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)).

## Implications for CDA-143

Each item is a decision Claude Code had to make too. Options and their consequences are listed
without a recommendation.

**1. Worktree location.**

- Inside the repository under a dot directory, as Claude Code does (`<repo>/.claude/worktrees/`):
  easy to find from the repository, but the directory shows as untracked unless it is ignored, and
  repository-wide tools (search, Biome, `tsc`) may walk into it. A committed symlink at that path
  can redirect writes outside the repository, which Claude Code refuses since 2.1.212.
- A sibling directory (`../<repo>-<name>`, the shape the git docs use): no ignore entry needed, but
  it writes outside the repository the user opened.
- A per-user data directory: nothing appears in the repository, but worktrees are harder to find and
  must be keyed by repository.

**2. Ignoring the worktree directory** (only if the worktree lives in the repository).

- Leave it to the user, as Claude Code does with a tip: worktree files show as untracked until the
  user acts.
- Write to `.git/info/exclude`: no tracked change, but invisible to the user.
- Edit `.gitignore`: visible, but it is a change the user did not ask for.

**3. Branch name.**

- A fixed prefix like `worktree-<name>`: easy to recognise and less likely to collide with the
  user's branches.
- A configurable prefix: the desktop app offers this.
- The bare name: may collide with existing branches.

Names with `/` need a decision either way (CHANGELOG 2.1.83).

**4. Base.**

- The remote default branch: a clean start, but it needs a fetch. Claude Code caps it at five
  seconds, never prompts, and falls back to local `HEAD`.
- Local `HEAD`: offline, and carries unpushed work.
- A setting covering both: Claude Code switched `EnterWorktree`'s base to local `HEAD` in 2.1.128
  and back to the remote default in 2.1.133, so neither base suits every user.

**5. Generated name.**

- Words only: readable, but collides sooner.
- Words plus a short random suffix: fewer collisions.

Either way the name must be valid as both a directory and a branch name, and a collision with an
existing worktree must either reopen it or pick another name.

**6. Outside a git repository and non-git VCS.**

- The planned clear error only.
- A create/remove extension point like `WorktreeCreate`/`WorktreeRemove`: adds a hook contract. It
  also means change detection and branch cleanup become the extension's job, because Claude Code's
  git-based checks see no changes in a non-git worktree.

A repository with no commits needs its own error message too.

**7. Cleanup on exit.**

- Claude Code's rule: auto-remove when clean and unnamed, prompt otherwise.
- Always keep: no data loss, but worktrees pile up.
- Always prompt.

Whatever the choice, we have to decide what counts as work (uncommitted changes, untracked files,
new commits, submodules) and what headless runs do. TerminalBench and `-p`-style runs have nobody
to answer a prompt; Claude Code keeps those worktrees. We also have to decide whether removal
deletes the branch and how to detect another Session in the same worktree. Claude Code takes a
`git worktree lock` at creation, does not document how it detects another session, and fixed a bug
here as late as 2.1.330. Its 2.1.143 fix shows the risk of an `rm -rf` fallback.

**8. Resume and listing.**

- What to store in the Session record: Claude Code keeps a binding plus a transcript under the
  worktree path. Its status line exposes name, path, branch, original directory and original branch
  for a worktree session, a hint of what it tracks.
- Where records are keyed: by worktree path (Claude Code's choice) or by repository (one list for
  all worktrees). Keyed by worktree path, a `--continue` that reads only the launch directory would
  not pick a worktree Session from the main checkout; this is inferred, the docs do not state it.
- What to check before re-entering: at least that the directory exists and is still a separate
  checkout of the same repository.
- A deleted worktree: fall back to the launch directory and clear the binding (Claude Code), or
  refuse the resume.
- Whether `--worktree <existing-name>` reopens the worktree, which Claude Code relies on for its
  printed resume command.

**9. Repository Root and isolation.** If the Session's Repository Root becomes the worktree, the
Path Jail already keeps file tools out of the main checkout. The shared `.git` still lets a
`bash` command reach the main checkout through `git -C`, `GIT_DIR` or `cd`. Claude Code needed
separate command checks for that, and its own docs note those checks do not catch `cp` or shell
redirects.

**10. Setting up the fresh checkout.** Gitignored files (`.env`) and dependencies
(`node_modules`) are missing in a new worktree.

- Leave setup to the user or the model.
- Copy a listed set of gitignored files (`.worktreeinclude`).
- Symlink or sparse-checkout directories (`worktree.symlinkDirectories`, `worktree.sparsePaths`).
