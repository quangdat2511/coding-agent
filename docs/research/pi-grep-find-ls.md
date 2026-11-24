# Pi's `grep`, `find` and `ls` tools: contracts and output

## Snapshot and scope

Research snapshot: **2026-11-24**. The Pi repository tip used here is
[`8209929fb553e7a8c91dc0894569f9ec43dd201f`](https://github.com/earendil-works/pi/commit/8209929fb553e7a8c91dc0894569f9ec43dd201f),
the `main` commit titled `fix(coding-agent): correct the fallbacks for unsaved bash output files (#12461)`,
dated 2026-11-23T23:55:42Z. Package metadata at this commit reports version `1.6.0` for
`pi-coding-agent`
([`package.json`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/package.json#L3)).
The agent loop cited for error wrapping is `packages/agent` in the same repository at this
commit, published as `@earendil-works/pi-agent-core` `1.6.0`
([`package.json`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/package.json#L1-L3)).

This note uses only Pi's source, tests, and in-repository documentation. It feeds
[CDA-150](https://datn-fit-hcmus.atlassian.net/browse/CDA-150) for the CDA-149 planning map, and
reports Pi's behaviour; it does not decide this repository's contract.

Terminology: "the model" means the LLM receiving the tool declaration and tool result. "Content"
is the text block a tool returns; "details" is the structured metadata beside it.

The three tools are siblings of `read` and `bash`: they live in
`packages/coding-agent/src/core/tools/`, are exported from that barrel, and are **not** part of
Pi's default four-tool set (`read`, `bash`, `edit`, `write`) — see §8. The map's context says
this repository will treat `rg` and `fd` as required binaries; Pi instead treats both as
downloadable on first use (§8). That difference is the largest gap between Pi's promise and a
required-binary design.

Where a statement depends on ripgrep's or fd's own defaults, it is cited to that project's
documentation at a pinned tag, because Pi runs whichever binary `ensureTool` finds or downloads
(only fd 10.3.0 on darwin/x64 is pinned, see
[`tools-manager.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L258-L260)).

## Question

What exactly do Pi's `grep`, `find` and `ls` tools promise: their parameter schemas and defaults,
the success output they produce (paths, line numbers, sorting, relative vs absolute, directory
suffix, empty results), their truncation and limit behaviour (match/result/entry caps, byte budget,
long-line truncation, details metadata), their ignore and filesystem semantics (`.gitignore`,
hidden files, binary files, symlinks, outside-repo paths, Windows normalisation), the exact
`rg`/`fd` argument construction and stderr/exit handling, how their results render in Pi's TUI, and
which error messages the model sees.

## Short answer

- **Shape.** `grep` searches file contents with `rg --json`; `find` lists paths with `fd`; `ls`
  lists one directory with `fs.readdir`. All three are read-only, take an optional `path` that
  defaults to `"."`, and resolve it against `ctx.cwd` when the extension context supplies one,
  otherwise against the tool's `cwd` ([grep](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L137-L145),
  [find](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L112-L114),
  [ls](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L82-L84)).
- **Defaults.** `grep`: `limit` 100, `context` 0, `ignoreCase` and `literal` false. `find`:
  `limit` 1000. `ls`: `limit` 500. Limits are floored and clamped to at least 1.
- **Output.** `grep` returns `path:line: text` for matches and `path-line- text` for context,
  paths relative to the search root with `/` separators. `find` returns paths relative to the
  search root with `/` separators, preserving a trailing separator if fd printed one. `ls` returns
  bare entry names sorted case-insensitively, directories suffixed `/`.
- **Ordering.** `ls` sorts; `grep` and `find` do not sort and inherit ripgrep's/fd's traversal
  order. Pi's own tests sort multi-result output before comparing.
- **Empty.** Empty results are successes, not errors: `No matches found`,
  `No files found matching pattern`, `(empty directory)`, each with `details: undefined`.
- **Caps.** `grep` caps matches (default 100), `find` caps results (1000), `ls` caps entries (500),
  and all three cap the joined text at **50 KB** (`DEFAULT_MAX_BYTES = 50 * 1024`). `grep` also
  truncates each output line to **500** characters.
- **Notices.** Caps and byte truncation append `\n\n[...]` to the content (the model sees them) and
  set typed fields on `details` (the TUI reads them). A cap is reported when Pi has evidence of one
  more item: `grep` waits for proof of one more match, `find` asks fd for `limit + 1`, and `ls`
  stops before stat-ing an entry it has not examined — so a broken symlink still raises the ls
  notice even though it would have been skipped.
- **Arguments.** `rg`: `--no-config --json --line-number --color=never --hidden`, then
  `--ignore-case`, `--fixed-strings`, `--glob`, `--context`, then `-- <pattern> .` with cwd set
  to the search root. `fd`: `--color=never --hidden`, `--no-require-git` when no `.git` exists at
  or above the search root, then `--glob --max-results <limit+1>`, `--full-path` for path
  patterns, and `-- <pattern> <search root>`. Windows path patterns take a different branch that
  lists every entry and filters with `minimatch`.
- **Ignore.** Both children run with `--hidden` but **without** `--no-ignore`: dotfiles are
  eligible, ignore files still apply. `grep` does not pass `--no-require-git`, so `.gitignore`
  only applies inside a git repository; `find` adds `--no-require-git` outside a repository, so it
  applies `.gitignore` everywhere. Neither adds an explicit `.git` exclusion.
- **TUI.** Each tool has a custom call header and result body. Results collapse to 15 lines
  (`grep`) or 20 (`find`, `ls`), with an expand hint; truncation is rendered from `details`, never
  by parsing the content text.
- **Errors.** Thrown `Error`s become tool results whose only content is the message, with
  `isError: true` and `details: {}`. The model sees plain sentences such as
  `Path not found: /abs/path`, `No matches found`, or `fd exited with code 1`; there is no
  `Error:` prefix and no stack trace.

## 1. Parameter schemas, defaults, and descriptions

All three schemas are TypeBox `Type.Object`s with **no schema-level defaults**: the default is
stated only in the parameter description, so a provider that omits an optional field gets the
fallback the code applies.

### `grep`

| Parameter | Type | Required | Description as declared |
|---|---|---|---|
| `pattern` | string | yes | "Search pattern (regex or literal string)" |
| `path` | string | no | "Directory or file to search (default: current directory)" |
| `glob` | string | no | "Filter files by glob pattern relative to path, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth" |
| `ignoreCase` | boolean | no | "Case-insensitive search (default: false)" |
| `literal` | boolean | no | "Treat pattern as literal string instead of regex (default: false)" |
| `context` | number | no | "Number of lines to show before and after each match (default: 0)" |
| `limit` | number | no | "Maximum number of matches to return (default: 100)" |

Source: [`grepSchema`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L20-L37).
The effective default is `DEFAULT_LIMIT = 100`
([L45](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L45)).

### `find`

| Parameter | Type | Required | Description as declared |
|---|---|---|---|
| `pattern` | string | yes | "Glob pattern relative to the search directory, e.g. 'src/**/*.ts'. Without '/', e.g. '*.ts', it matches file names at any depth" |
| `path` | string | no | "Directory to search in (default: current directory)" |
| `limit` | number | no | "Maximum number of results (default: 1000)" |

Source: [`findSchema`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L26-L33),
[`DEFAULT_LIMIT`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L42).

### `ls`

| Parameter | Type | Required | Description as declared |
|---|---|---|---|
| `path` | string | no | "Directory to list (default: current directory)" |
| `limit` | number | no | "Maximum number of entries to return (default: 500)" |

Source: [`lsSchema`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L10-L13),
[`DEFAULT_LIMIT`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L22).

### Model-visible description and prompt snippet

The `description` is what the model reads: the agent loop declares each tool by copying
`name`, `description` and the JSON-round-tripped `parameters` into the tool declaration
([`toToolDeclaration`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/ai/src/utils/transcript.ts#L123-L130)).
The `promptSnippet` is listed once in the system prompt's tools section. The texts are composed
from the same constants as the caps, so they cannot drift silently.

- `grep` description: "Search file contents for a pattern. Returns matching lines with file paths
  and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is
  hit first). Long lines are truncated to 500 chars."
  ([L90](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L90));
  snippet: "Search file contents for patterns (respects .gitignore)"
  ([L39-L42](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L39-L42)).
- `find` description: "Search for files by glob pattern. Returns matching file paths relative to
  the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever
  is hit first)."
  ([L79](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L79));
  snippet: "Find files by glob pattern (respects .gitignore)"
  ([L35-L38](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L35-L38)).
- `ls` description: "List directory contents. Returns entries sorted alphabetically, with '/'
  suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever
  is hit first)."
  ([L61](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L61));
  snippet: "List directory contents"
  ([L15-L18](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L15-L18)).

The system prompt lists `- <name>: <snippet>` for every selected tool that has a snippet, then
"Additional tools may be available."
([`buildSystemPromptSections`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/system-prompt.ts#L150-L161)).
If `bash`/`powershell` is enabled and none of `grep`, `find`, `ls` is, the prompt adds the rule
"Use bash for file operations like ls, rg, find"
([L102-L116](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/system-prompt.ts#L102-L116)).

None of the three opts into constrained (strict) sampling: only `read`, `bash`, `powershell`,
`edit` and `write` set `constrainedSampling: { type: "json_schema", strict: "prefer" }`, and the
test asserts `grep`, `find` and `ls` leave it `undefined`
([`builtin-tool-strict-mode.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/builtin-tool-strict-mode.test.ts#L13-L31)).

## 2. Success output

### `grep`

One line per match, and one per context line, joined with `\n` in the order ripgrep emits them.
There is no blank line or header between files
([`pushLine`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L220-L236)):

```text
src/a.ts:12: const x = 1;
src/a.ts-13- // context line
src/b.ts:4: needle
```

- **Match line:** `${path}:${lineNumber}: ${text}`.
- **Context line** (when `context > 0`): `${path}-${lineNumber}- ${text}`. Dashes instead of
  colons, ripgrep's `--context` format, so a model can tell a match from its surroundings without
  re-reading the file.
- **Path.** When `path` is a directory, each result path is made relative to the search root and
  Windows separators are rewritten to `/`; a path that is empty or starts with `..` falls back to
  `path.basename`. When `path` is a file, the result path is always the basename, so a search of
  `/tmp/x/example.txt` prints `example.txt:2: ...`, not the absolute path
  ([`formatPath`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L151-L159);
  [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L970-L981)).
- **Line number.** `data.line_number` from ripgrep's JSON, one-based and per file. Context lines
  keep their own numbers.
- **Text.** One trailing line terminator is stripped with `/\r?\n?$/`; a lone `CR` inside a line is
  kept as content, matching what `read` shows. Mixed CRLF/LF input keeps both behaviours
  ([L223-L224](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L223-L224);
  [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1108-L1127)).
- **Ordering.** Pi applies no sort. Tests that compare multi-file output sort it first
  ([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1213-L1216)).
- **Empty:** exactly `No matches found`, `details: undefined`
  ([L285-L290](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L285-L290)).

### `find`

One path per line, joined with `\n`, each relative to the search root with `/` separators
([`relativizeFindResultPath`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L13-L24)):

```text
src/a.ts
src/b.ts
```

- Absolute results are relativised with `path.relative(searchPath, resultPath)`; already-relative
  results pass through. Separators are normalised to `/` on every platform.
- Each stdout line is trimmed before relativisation, so a file named `report.txt ` (with a trailing
  space) comes back as `report.txt`. fd preserves the trailing space when writing to a pipe on Unix;
  the loss comes from Pi's `.trim()`, not fd
  ([fd output.rs L202-L215](https://github.com/sharkdp/fd/blob/v10.5.2/src/output.rs#L202-L215),
  [Pi find.ts L279-L283](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L279-L283)).
- A trailing separator fd printed is preserved and re-attached after normalisation, so a directory
  result that fd printed as `dir/` stays `dir/`
  ([L19-L23](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L19-L23)).
- There is **no file-type filter**: Pi passes no `--type`, so fd's default entry set (files and
  directories) applies
  ([args](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L187-L249);
  [fd `--type`](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L216-L240)).
  A directory whose name matches the glob can therefore appear in `find` output.
- **Ordering.** No sort; fd's order is used. fd documents that result order is not guaranteed
  ([fd.1](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L463-L464)),
  and Pi's tests sort before comparing
  ([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1319-L1320)).
- **Empty:** exactly `No files found matching pattern`, `details: undefined`
  ([L311-L319](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L311-L319)).

### `ls`

One bare entry name per line, joined with `\n`; no directory, no path prefix
([L111-L130](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L111-L130)):

```text
.hidden-dir/
.hidden-file
README.md
src/
```

- **Sorting.** `entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))`:
  case-insensitive, locale-aware, ascending. Because the comparison lowercases both sides, names
  that differ only by case compare equal and keep their `readdir` order (`Array.prototype.sort` is
  specified stable)
  ([L108-L109](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L108-L109)).
- **Directory suffix.** `stat()` is called per entry; a directory gets `/`, a file or symlink to a
  file gets nothing
  ([L120-L129](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L120-L129)).
- **Unstatable entries are skipped.** A dangling symlink or a permission failure makes the
  `stat()` throw, and `continue` skips that entry: it is neither listed nor counted toward the
  limit ([L122-L128](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L122-L128)).
- **Dotfiles** are always included: `ls` applies no ignore rules at all
  ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1412-L1421)).
- **Empty:** `(empty directory)`, `details: undefined` — also the result when a directory exists
  but every entry was skipped as unstatable
  ([L134-L137](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L134-L137)).

## 3. Truncation, limits, and details

### Constants

| Constant | Value | Meaning |
|---|---|---|
| `DEFAULT_MAX_BYTES` | `50 * 1024` = 51,200 | Byte cap for the joined content of every tool |
| `DEFAULT_MAX_LINES` | 2000 | Not used by these three: each passes `maxLines: Number.MAX_SAFE_INTEGER` |
| `GREP_MAX_LINE_LENGTH` | 500 | Max UTF-16 code units per grep output line |

Source: [`truncate.ts` L11-L13](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/truncate.ts#L11-L13).
The byte cap is formatted for humans by `formatSize`: `50.0KB`
([L65-L73](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/truncate.ts#L65-L73)).

### Limit arithmetic

```ts
const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
```

A missing limit uses the default; `0`, negative values and fractions below 1 become 1; fractions
are floored (`1.9` → 1). Tests pin this for `find` and `ls`
([find L113-L114](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L113-L114),
[ls L83-L84](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L83-L84),
[find test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1346-L1360),
[ls test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1423-L1431)).
`grep` clamps `context` separately to `Math.min(Math.floor(context), Number.MAX_SAFE_INTEGER)` so
`String()` can never produce exponent notation, which ripgrep rejects
([L147-L150](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L147-L150);
[1e30 test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1081-L1094)).

### How each cap is proven, not guessed

A limit notice is emitted only when Pi has evidence of at least one more item. For `grep` and
`find` that evidence is a received or counted item, so "exactly N" never looks truncated; for `ls`
it is an entry Pi has not stat-ed yet, so the notice means one entry was left unexamined, not that
it would have been listable.

- **`grep`** counts matches as events arrive. The Nth match sets `limitHit`; Pi keeps reading the
  same match's trailing context (up to `lineNumber + context`), prints any match that falls inside
  that window as a context line, and sets `matchLimitReached` only when another `match` event
  appears, then kills `rg`
  ([L211-L268](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L211-L268)).
  The test with exactly `limit` matches asserts no notice and `details.matchLimitReached === undefined`
  ([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1129-L1161)).
- **`find`** asks fd for `effectiveLimit + 1` results (`--max-results`), and treats
  `results.length > effectiveLimit` as the limit being reached; it then reports the limit but prints
  only `effectiveLimit` paths
  ([L237-L238](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L237-L238),
  [L284-L289](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L284-L289)).
  In the Windows path-pattern branch there is no `--max-results`, so Pi counts results itself and
  stops the child at the first result past the limit
  ([L283-L288](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L283-L288)).
- **`ls`** iterates the sorted entries and checks `results.length >= effectiveLimit` before
  stat-ing the next one, setting `entryLimitReached` and stopping. With `limit: 1`, a valid entry
  followed by a broken symlink still sets the flag even though the symlink would have been skipped;
  the notice confirms an entry remains, not that it is listable
  ([L111-L129](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L111-L129)).

### Byte cap

All three build the full text, then call `truncateHead(text, { maxLines: Number.MAX_SAFE_INTEGER })`,
so only the byte cap can fire. `truncateHead`:

- returns the content unchanged when it fits both caps
  ([L90-L105](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/truncate.ts#L90-L105));
- never returns a partial line: it adds whole lines until the next one would exceed `maxBytes`, then
  sets `truncatedBy: "bytes"`
  ([L125-L163](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/truncate.ts#L125-L163));
- returns **empty content** with `firstLineExceedsLimit: true` when the first line alone is over
  the cap — reachable in principle for a single enormous path or line
  ([L107-L123](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/truncate.ts#L107-L123)).

Totals differ per tool:

- `grep` counts **every** line and byte, including lines past the cap that were counted but not
  stored, then overwrites `truncation.totalLines` / `totalBytes` with those full totals. That is
  why a result can say both "150 matches limit reached" and "50.0KB limit reached"
  ([L207-L235](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L207-L235),
  [L292-L297](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L292-L297);
  [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1046-L1078)).
- `find` stores results only up to the byte cap but keeps counting, then reports `resultCount` and
  the full byte total
  ([L257-L292](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L257-L292),
  [L321-L327](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L321-L327)).
- `ls` truncates only the entries that survived the entry cap, so its `truncation.totalLines` is at
  most `limit`; the directory's remaining entries are represented by `entryLimitReached`
  ([L139-L153](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L139-L153)).

### Per-line truncation (`grep` only)

Every match and context line goes through `truncateLine` before formatting
([L226-L230](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L226-L230)).
A line longer than 500 UTF-16 code units becomes its first 500 units plus `... [truncated]`; the
cut never splits a surrogate pair
([L277-L294](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/truncate.ts#L277-L294)).
The first truncated line sets `details.linesTruncated = true`, which also adds a notice.

### Notices (content) and details (metadata)

When any cap fires, Pi appends a single bracketed paragraph after a blank line, joining notices with
`". "` ([grep L299-L317](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L299-L317)):

| Tool | Notice text | Details field |
|---|---|---|
| `grep` | `${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern` | `matchLimitReached: limit` |
| `grep` | `50.0KB limit reached` | `truncation: TruncationResult` |
| `grep` | `Some lines truncated to 500 chars. Use read tool to see full lines` | `linesTruncated: true` |
| `find` | `${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern` | `resultLimitReached: limit` |
| `find` | `50.0KB limit reached` | `truncation` |
| `ls` | `${limit} entries limit reached. Use limit=${limit * 2} for more` | `entryLimitReached: limit` |
| `ls` | `50.0KB limit reached` | `truncation` |

Example: `[1 entries limit reached. Use limit=2 for more]` and
`[2 results limit reached. Use limit=4 for more, or refine pattern]`
([ls test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1423-L1439),
[find test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1324-L1344)).

The details objects are exactly:

```ts
interface GrepToolDetails { truncation?: TruncationResult; matchLimitReached?: number; linesTruncated?: boolean }
interface FindToolDetails { truncation?: TruncationResult; resultLimitReached?: number }
interface LsToolDetails   { truncation?: TruncationResult; entryLimitReached?: number }
```

([grep](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L47-L51),
[find](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L44-L47),
[ls](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L24-L27)).
`details` is `undefined` when no field is set
([example](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L318-L323)).
`TruncationResult` carries `content`, `truncated`, `truncatedBy` (`"lines" | "bytes" | null`),
`totalLines`, `totalBytes`, `outputLines`, `outputBytes`, `lastLinePartial`,
`firstLineExceedsLimit`, `maxLines` and `maxBytes`
([L15-L38](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/truncate.ts#L15-L38)).
So `details.truncation.content` duplicates the truncated text that is also in `content`.

### Inconsistencies worth knowing

- `find`'s extension seam (`customOps.glob`) emits `${limit} results limit reached` with **no**
  "Use limit=..." hint, unlike the `fd` path
  ([L155-L166](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L155-L166)).
- That same seam is handed `ignore: ["**/node_modules/**", "**/.git/**"]` and `limit + 1`
  ([L127-L131](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L127-L131)),
  while the built-in `fd` path passes no such exclusions.
- `ls`'s abort handler rejects but never removes its listener
  ([L77-L78](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L77-L78));
  the promise's first settlement still wins.

## 4. Ignore and filesystem semantics

### Hidden files

Both children run with `--hidden`: ripgrep then does not skip dotfiles
([rg `--hidden`](https://github.com/BurntSushi/ripgrep/blob/4649aa9700619f94cf9c66876e9549d83420e16c/crates/core/flags/defs.rs#L2721-L2756)),
and fd includes hidden entries but still excludes ignored ones
([fd.1](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L51-L56)).
Pi's `find` test asserts a hidden `.secret/hidden.txt` is returned when not gitignored
([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1253-L1272)).
`ls` has no hidden-file concept and always lists dotfiles.

### `.gitignore` — and the asymmetry between `grep` and `find`

ripgrep honors git-related ignore files **only inside a source-control repository** unless
`--no-require-git` is passed
([rg docs](https://github.com/BurntSushi/ripgrep/blob/4649aa9700619f94cf9c66876e9549d83420e16c/crates/core/flags/defs.rs#L4749-L4765)).
Pi's `grep` does not pass that flag, so outside a git repository `.gitignore` files are **not**
honored, even though the tool description says "Respects .gitignore"
([args](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L161-L173)).

`find` compensates: before spawning fd it walks from the search root to the filesystem root looking
for a `.git` entry, and only when it finds none does it add `--no-require-git`; inside a repository
it keeps fd's git-aware default so parent ignore rules stop at nested repository boundaries
([L189-L203](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L189-L203),
[fd `--no-require-git`](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L95-L100)).
The `find` test that writes a `.gitignore` and expects `ignored.txt` to disappear therefore runs in
a temporary directory with no `.git`, exercising exactly this branch
([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1274-L1287)).

`ls` applies no ignore rules: it lists every entry, ignored or not.

### Other ignore files

Neither child gets `--no-ignore`, so the rest of each tool's ignore stack still applies:
`.ignore`/`.rgignore` and the global git excludes for ripgrep, `.ignore`/`.fdignore` for fd.
`--no-config` on `rg` only disables `RIPGREP_CONFIG_PATH`, so ambient user configuration cannot
change the tool's contract; Pi's test sets `RIPGREP_CONFIG_PATH` to `--fixed-strings` and expects
the pattern to stay a regex
([L161-L167](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L161-L167),
[test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1164-L1186)).

### `.git` itself

Neither invocation adds an explicit `.git` exclusion, and fd's walker configures only hidden and
ignore-file filtering, with no `.git` special case
([fd `walk.rs`](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/src/walk.rs#L344-L365)).
The only default filter that skips `.git` is the hidden-file filter, which `--hidden` turns off;
both tools define a hidden entry as one whose name starts with a dot
([rg](https://github.com/BurntSushi/ripgrep/blob/4649aa9700619f94cf9c66876e9549d83420e16c/crates/core/flags/defs.rs#L2721-L2756),
[fd](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L51-L56)).
So `.git` contents are **eligible** for both tools unless a pattern or ignore rule excludes them.
This is a real edge case for a repo-bounded design.
(Pi's extension-facing `ignore` list for `find` names `**/.git/**`, but the built-in fd path does
not use it.)

### Binary files

`grep` leaves ripgrep in its default binary mode. ripgrep applies two NUL modes depending on how the
path arrives:
- With a directory search, it may emit matches from a file before it detects a NUL and then stop
  that file; later matches are suppressed.
- With a direct file path, it can find matches after the NUL, because the check follows directory
  traversal rather than the file's content alone.
In `--json` output, the `end` event can carry `binary_offset` when a NUL is found, but Pi's parser
handles only `match` and `context`, so it never reads that field
([ripgrep JSON test L891-L917](https://github.com/BurntSushi/ripgrep/blob/14.1.1/crates/printer/src/json.rs#L891-L917),
[Pi grep.ts L238-L251](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L238-L251)).
The warning on stderr is not guaranteed; the GUIDE describes the mode, not a per-file warning
([GUIDE L735-L758](https://github.com/BurntSushi/ripgrep/blob/14.1.1/GUIDE.md#L735-L758)).
Pi captures stderr but only uses it when rg exits non-zero, so any binary-suppression warning never
reaches the model on a successful search
([L274-L284](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L274-L284)).
`find` and `ls` only handle names and never read file contents.

### Symlinks

- `rg` does not follow symbolic links by default, and Pi passes no `--follow`
  ([GUIDE](https://github.com/BurntSushi/ripgrep/blob/4649aa9700619f94cf9c66876e9549d83420e16c/GUIDE.md#L191-L199)).
  A symlinked **search root** still works: for directory searches Pi sets the child's cwd to the
  search root, and ripgrep canonicalises its own cwd; the glob test runs the same assertions through
  a symlinked root
  ([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1195-L1232)).
- `fd` does not descend into symlinked directories by default, and Pi passes no `--follow`
  ([fd.1](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L147-L149)).
- `ls` uses `fs.stat`, which follows links: a symlink to a directory gets `/`, a dangling symlink
  throws and is skipped.

### Outside the working directory

Pi imposes no root: `resolveToCwd` accepts absolute paths, `..`, and `~`, and neither tool
re-checks the result. Pi's security documentation states that the working folder "does not prevent
commands from accessing other paths available to the Pi process"
([`security.md` L19](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/security.md#L19)).
The only path validation in the three tools is `ls`'s existence/directory check and `grep`'s
`stat` for the directory-vs-file branch; `find` spawns fd without checking that the path exists.

### Path resolution and Windows normalisation

All three resolve the argument with `resolveToCwd`, which delegates to `resolvePath` with
`normalizeUnicodeSpaces: true` and `stripAtPrefix: true`
([`path-utils.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/path-utils.ts#L44-L50)).
`normalizePath` then:

- turns Unicode space variants into a normal space, strips a leading `@`, and expands `~` /
  `~/` against `os.homedir()`;
- on Windows, converts Git Bash / MSYS / Cygwin / WSL drive paths such as `/c/...`,
  `/mnt/c/...` and `/cygdrive/c/...` into `C:\...`; a path containing a backslash or starting
  with `//` is left alone;
- turns `file://` URLs into filesystem paths;
- resolves relative inputs against the base directory with `node:path.resolve`.

Sources: [`normalizeWindowsShellPath`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/paths.ts#L111-L118),
[`normalizePath`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/paths.ts#L120-L145),
[`resolvePath`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/paths.ts#L147-L151).

Output paths are always portable: `grep` rewrites Windows separators to `/` when relativising, and `find`'
relativiser joins with `/` on every platform. `ls` prints names as the filesystem returns them.

## 5. Exact rg/fd invocation and process handling

### `grep` — ripgrep arguments

```text
rg --no-config --json --line-number --color=never --hidden
   [--ignore-case] [--fixed-strings]
   [--glob <glob>]
   [--context <n>]
   -- <pattern> <"." | absolute file path>
```

([L161-L173](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L161-L173))

- `cwd` is the resolved search root when it is a directory; for a single-file search no cwd is set
  ([L175-L178](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L175-L178)).
- Directory searches pass `"."` as the path, not the directory, because ripgrep canonicalises its
  cwd and an absolute symlinked path would otherwise no longer sit under the glob root
  ([comment](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L170-L173)).
- `--glob` is one argument plus its value, so it can be negated with `!`; a leading `./` (or
  several) is stripped after an optional `!`, because ripgrep matches nothing for `./src/*.ts`
  ([L166-L167](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L166-L167)).
  Unlike fd, ripgrep's `--glob` takes the pattern as its value.
- `--context` is only passed when `context > 0`; the value is the clamped floor
  ([L168-L169](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L168-L169)).
- `--` precedes the pattern, so a pattern starting with `-` is search text, not a flag. The test
  passes `--pre=<script>` and asserts "No matches found" and that the script never ran
  ([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1235-L1250)).
- **No smart case.** `grep` is case-sensitive unless `ignoreCase` adds `--ignore-case`; there is
  no `--smart-case` or `-S` anywhere in the invocation.
- `--json` events are parsed line by line: only `match` and `context` events are used, path and
  line text are decoded from `text` or base64 `bytes` (non-UTF-8 data), and a non-JSON or empty
  line is skipped
  ([L70-L75](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L70-L75),
  [L238-L251](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L238-L251)).

### `find` — fd arguments

Default branch (all platforms except Windows path patterns):

```text
fd --color=never --hidden [--no-require-git]
   --glob --max-results <limit + 1>
   [--full-path]
   [--ignore-case]
   -- <pattern> <search root>
```

([L187-L249](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L187-L249))

- `--no-require-git` is added only when no `.git` is found at or above the search root
  ([L193-L203](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L193-L203)).
- `--glob` here is a **switch** (fd's "interpret the pattern as a glob" flag), not a value-taking
  option; the pattern is the positional argument after `--`
  ([fd.1](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L114-L117)).
- `--full-path` is added only when the pattern contains `/`, so fd matches against the whole path
  rather than the basename
  ([L205-L206](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L205-L206),
  [fd `--full-path`](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L151-L156)).
- A relative path pattern is anchored at the search root by prefixing the glob-escaped root to the
  pattern: `src/*.ts` becomes `<root>/src/*.ts`, while `**/src/*.ts` matches at any depth
  ([L215-L218](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L215-L218),
  [L240-L247](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L240-L247)).
  The root's trailing slashes are removed, and the backslash, `*`, `?`, `[`, `]`, `{` and `}`
  characters are backslash-escaped.
- **Smart case.** fd is case-insensitive when the pattern has no uppercase letter
  ([fd.1](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1#L38-L41)).
  Pi precomputes that decision from the **user's** pattern and, for a prefixed relative pattern,
  passes `--ignore-case` explicitly so the search root's letters cannot flip fd's smart case
  ([L213-L214](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L213-L214),
  [L242-L246](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L242-L246)).
  Non-path patterns rely on fd's own smart case.
- On Windows, a backslash in the pattern is first replaced with `/`, so a native-looking
  `src\**\*.ts` works; on POSIX a backslash stays a glob escape
  ([L207-L211](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L207-L211);
  [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1308-L1321)).
- A leading `./` (or several) is stripped; if no `/` remains, the pattern falls back to fd's
  basename matching at any depth
  ([L210-L212](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L210-L212),
  [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1313-L1321)).

### Windows path-pattern workaround

fd before 10.5.1 never matched `--full-path` globs on Windows, and workarounds for that version
break on 10.5.1 (sharkdp/fd#2067). Because Pi cannot rely on either version, on Windows a **path**
pattern switches to:

```text
fd --color=never --hidden [--no-require-git] -- "" <search root>
```

i.e. fd lists every entry, and Pi filters each line with `minimatch`
([L219-L235](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L219-L235),
[L283-L288](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L283-L288)).
The minimatch options deliberately mirror fd's matching:

- `dot: true` — fd's `*` matches dotfiles;
- `noext: true` — `+(a|b)` is a literal, as in fd's glob engine;
- `nocase` — Pi's smart-case decision;
- a trailing `/**` becomes `/**/*`, because minimatch's `src/**` also matches `src` itself and
  fd's does not;
- relative patterns are matched against the relativised result, absolute patterns against fd's raw
  absolute line.

This branch has no `--max-results`, so Pi stops the child once it has seen one result past the
limit ([L283-L288](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L283-L288)).

### stderr, exit codes, abort, and early stop

`grep`:

- stderr is accumulated and otherwise ignored
  ([L203-L205](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L203-L205)).
- Exit codes 0 and 1 are success (1 is "no matches"). Any other code is an error **unless** Pi
  killed the child itself because it hit the limit, in which case the partial output is kept. The
  message is `stderr.trim()` or `ripgrep exited with code <n>`
  ([L280-L284](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L280-L284)).
- Abort rejects with `Operation aborted` and kills the child
  ([L192-L202](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L192-L202),
  [L274-L279](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L274-L279)).
- Hitting the match limit calls `child.kill()`; `killedDueToLimit` makes the resulting non-zero
  signal exit non-fatal
  ([L216-L219](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L216-L219),
  [L192-L197](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L192-L197)).

`find`:

- A non-zero exit is an error **only when zero results were read**; if fd printed some paths first,
  the partial result is returned. The message is `stderr.trim()` or `fd exited with code <n>`
  ([L300-L310](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L300-L310)).
  This is how a glob parse error surfaces when there are no results
  ([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1289-L1296)).
- Abort rejects with `Operation aborted` and kills the child
  ([L104-L108](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L104-L108),
  [L265-L269](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L265-L269)).
- fd is asked for `limit + 1` so the limit decision needs no guess, and stops itself
  ([L237-L238](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L237-L238)).

`ls` spawns nothing; errors are the thrown messages of §7.

## 6. TUI rendering and the details/content split

Each tool's definition spreads a renderer pair (`renderCall`, `renderResult`) from
`core/tools/renderers/`. The renderers are separate modules so a process that only displays tool
output does not load the execution path or the TypeBox schema; the tool file spreads them in, so
the public definition is unchanged
([grep renderer](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/grep.ts#L1-L7),
[`...grepRenderers`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L331-L332)).

### Call headers

- `grep`: bold `grep`, the pattern as `/<pattern>/` in the accent colour, ` in <path>`, then
  ` (<glob>)` when a glob is set, then ` limit <n>` (no parentheses around the limit).
  The path is home-shortened (`~`), and an empty path renders as `.`
  ([L17-L35](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/grep.ts#L17-L35)).
- `find`: bold `find`, the pattern, ` in <path>`, then ` (limit <n>)` when a limit is set
  ([L17-L32](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/find.ts#L17-L32)).
- `ls`: bold `ls`, the path rendered as an accent-coloured, home-shortened link with an empty
  fallback of `.`, then ` (limit <n>)` when a limit is set
  ([L17-L25](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/ls.ts#L17-L25)).
- A non-string argument renders as `[invalid arg]` in the error colour
  ([`invalidArgText`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/render-utils.ts#L166-L168)).
- `ls` uses `renderToolPath`, which hyperlinks to the file URL when the terminal supports
  hyperlinks ([L170-L180](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/render-utils.ts#L170-L180)).

### Result bodies

- Content is taken from the text blocks via `getTextOutput`, which strips ANSI, sanitises binary
  output and removes `\r`
  ([L53-L78](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/render-utils.ts#L53-L78)).
- Collapsed height: `grep` 15 lines, `find` and `ls` 20 lines; expanded (`options.expanded`) shows
  every line. Extra lines render as `... (N more lines, <key> to expand)`
  ([grep](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/grep.ts#L45-L55),
  [find](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/find.ts#L42-L52),
  [ls](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/ls.ts#L35-L45)).
- A truncation line is appended in the warning colour, derived from **details**, not from the
  content text: `[Truncated: 100 matches limit, 50.0KB limit, some lines truncated]` for grep,
  `[Truncated: N results limit, 50.0KB limit]` for find, and `[Truncated: N entries limit,
  50.0KB limit]` for ls
  ([grep](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/grep.ts#L58-L67),
  [find](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/find.ts#L55-L62),
  [ls](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/ls.ts#L48-L55)).
- Each renderer reuses the previous `Text` component and calls `setText`, so a redraw updates one
  component instead of allocating a new one
  ([grep](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/grep.ts#L71-L82)).

### What is in content vs details

- **Content** is the only thing the model sees: the lines plus the `\n\n[...]` notice paragraph.
- **Details** is structured metadata for the UI and SDK: the limit numbers, the truncation record
  (including the full truncated text and totals), and `linesTruncated`. It is omitted entirely
  when empty, so a successful untruncated call has `details: undefined`.
- The TUI does not print totals or `details.truncation.content`; it prints only the counts.
- The tool-result message recorded in the session carries `details` beside `content`
  ([`createToolResultMessage`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L933-L947)),
  so downstream renderers (HTML export, RPC clients) can read the same metadata.

### Empty results and the TUI

Because empty results are successful text ("No matches found", etc.), the TUI shows that sentence
as an ordinary result line, not as an error row.

## 7. Errors the model sees

Thrown errors do not reach the model verbatim as exceptions: the agent loop catches them, wraps the
message in a text block, sets `isError: true` and `details: {}`, and records that as the tool
result ([execute catch](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L824-L860),
[`createErrorToolResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L915-L920),
[`createToolResultMessage`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L933-L947)).
Argument validation and unknown tools take the same path
([L718-L732](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L718-L732),
[L772-L778](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L772-L778)).
The model therefore sees the bare message, with no `Error:` prefix and no stack trace; `isError`
is what the TUI uses to style the row.

| Tool | Condition | Message |
|---|---|---|
| `grep` | aborted before or during the call | `Operation aborted` |
| `grep` | `rg` missing and not downloadable | `ripgrep (rg) is not available and could not be downloaded` |
| `grep` | `path` cannot be stat'ed | `Path not found: <absolute resolved path>` |
| `grep` | spawn failed | `Failed to run ripgrep: <error.message>` |
| `grep` | rg exited with a code other than 0/1 and Pi did not kill it | `<stderr.trim()>` or `ripgrep exited with code <n>` |
| `find` | aborted | `Operation aborted` |
| `find` | custom operations: path missing | `Path not found: <absolute path>` |
| `find` | `fd` missing and not downloadable | `fd is not available and could not be downloaded` |
| `find` | spawn failed | `Failed to run fd: <error.message>` |
| `find` | non-zero exit with zero results | `<stderr.trim()>` or `fd exited with code <n>` |
| `ls` | aborted | `Operation aborted` |
| `ls` | path missing | `Path not found: <absolute path>` |
| `ls` | path is a file | `Not a directory: <absolute path>` |
| `ls` | `readdir` failed | `Cannot read directory: <error.message>` |

Sources: [grep](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L117-L145),
[find](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L176-L185),
[ls](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L86-L106).

Two consequences:

- **stderr surfaces only on a failed search.** For `grep`, Pi reports the child's `stderr.trim()`
  (when non-empty) or `ripgrep exited with code <n>` whenever rg exits with a code other than 0 or 1
  and Pi did not kill it for the match limit, even if the search already produced matches. For
  `find`, both conditions are required: fd must exit non-zero **and** Pi must have read no results.
  If fd exits 0 with an empty result set, Pi returns success even when stderr has content
  ([find.ts L300-L319](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L300-L319)).
- **The error message carries no remedy.** It is the child's text or a fixed sentence; there is no
  hint to change `path`, install `rg`, or narrow `glob`.

## 8. Availability, registration, and defaults

- **Availability.** `grep` and `find` call `ensureTool("rg" | "fd")` at the start of every call.
  `getToolPath` looks first for a Pi-managed binary in `<agent dir>/bin` (with `.exe` on Windows),
  then for system commands `rg`, or `fd` then `fdfind`
  ([`tools-manager.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L42-L58),
  [`getToolPath`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L72-L91),
  [`getBinDir`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/config.ts#L664-L666)).
  If neither exists, `ensureTool` downloads the latest GitHub release for x64/arm64 on
  Linux/macOS/Windows, extracts it with `tar`/`unzip`/`powershell.exe`, and `chmod 0755`s it
  ([L337-L397](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L337-L397)).
  Offline (`PI_OFFLINE=1|true|yes`), Termux and unmapped architectures skip the download and return
  `undefined`, producing the "not available and could not be downloaded" error. The download
  failure detail is shown as a UI status warning, not in the tool result.
- **Defaults.** `read`, `bash`, `edit`, `write` are enabled by default; `grep`, `find`, `ls` are
  opt-in via `defaultTools` or `--tools`
  ([`cli.md` L130](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/cli.md#L130),
  [`cli.md` L142-L151](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/cli.md#L142-L151),
  [`settings.md` L42](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/settings.md#L42)).
- **Tool names.** `allToolNames` includes `grep`, `find` and `ls`; the read-only composition is
  exactly `read`, `grep`, `find`, `ls`, while the coding composition is `read`, `bash`, `edit`,
  `write`
  ([`index.ts` L95-L105](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/index.ts#L95-L105),
  [L164-L180](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/index.ts#L164-L180)).
  This matches the map's "read-only" requirement: Pi already has a read-only tool set, and it is
  exactly these three plus `read`.
- **Extension seams.**
  - `GrepOperations` exposes only `isDirectory`; `readFile` is documented as ignored and deprecated.
    To search a remote system, an extension must override `execute()`
    ([`GrepOperations`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L53-L64)).
  - `FindOperations` exposes `exists` and `glob`; supplying `glob` replaces fd entirely and
    receives `ignore: ["**/node_modules/**", "**/.git/**"]` and `limit + 1`
    ([`FindOperations`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L49-L69),
    [L117-L131](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L117-L131)).
  - `LsOperations` exposes `exists`, `stat` and `readdir`
    ([`LsOperations`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts#L29-L46)).

## Open questions for this repo

These are decisions this note cannot make. Each names Pi's precedent and where the answer would live.

1. **Budgets and notices.** This repo's current limit is 40 KiB for every tool, inclusive of the
   `[...output truncated...]` marker
   ([ADR 0001 §3, amendment L145-L149](../../docs/adr/0001-tool-contracts-and-safety-policy.md#L145-L149);
   `packages/tools/src/output-budget.ts` L3-L9, L21-L35). Pi caps joined output at 50 KiB and appends
   a `[...]` notice to the content; only `grep` has a per-line rule (500 UTF-16 units). How should
   Pi-style notices fit inside the 40 KiB budget?
2. **Root bounding.** Pi accepts any absolute path or `..` (`docs/security.md` L19). This repo's
   `WorkspaceResolver` jails inputs to the canonical root and refuses symlinks
   (`packages/tools/src/workspace.ts` L70-L102), so an escaping `path` must fail with
   `PATH_OUTSIDE_REPO` (ADR 0001 §2). The open question is how the bound is enforced while
   `rg`/`fd` traverse a directory rather than per-file opens.
3. **Required binaries.** Pi downloads `rg`/`fd` on first use and has a distinct error per failure
   (`tools-manager.ts` L337-L397). If this repo requires them, what floor is promised (Pi's Windows
   workaround exists because fd <10.5.1 is broken, `find.ts` L219-L233), how are they found on
   Windows (`fd.exe`, `rg.exe`, `fdfind`), and what does the model see when they are missing?
4. **Determinism.** Pi does not sort `grep`/`find` output; `ls` sorts case-insensitively
   (`ls.ts` L108-L109). If TerminalBench runs need reproducible output, should results be sorted,
   and what does that cost `grep`'s early stop?
5. **Ignore leakage.** `--hidden` with no `.git` exclusion leaves `.git` eligible, and `grep`
   honours `.gitignore` only inside a repo while `find` honours it everywhere. Should this repo add
   `--glob '!.git/**'` (and the fd equivalent), and should both tools agree on `--no-require-git`?
6. **Output and details shape.** Does this repo copy `path:line: text` / `path-line- text` (ambiguous
   for paths containing `:` or `-`)? Pi also carries per-tool metadata (`matchLimitReached`,
   `truncation`, ...) in `details`; putting that metadata into `ToolOutcome` would extend the shared
   contract between Tools and Agent Core
   ([ADR 0004](../../docs/adr/0004-package-apis-and-dependency-direction.md#L316-L328)), so it
   needs its own decision rather than riding along with the output format.
7. **Empty success vs error.** Pi returns `No matches found`, `No files found matching pattern` and
   `(empty directory)` as successful text, reserving errors for missing paths and process failures;
   this repo's `read` errors on a missing file. Which convention do the three read-only tools follow?
8. **Windows and seams.** Does `find` promise native-backslash patterns and the minimatch branch, or
   a higher fd floor? And are Pi's `GrepOperations`/`FindOperations`/`LsOperations` seams needed now,
   or only when a remote tool appears?

## Sources

Pi, pinned at `8209929fb553e7a8c91dc0894569f9ec43dd201f`:

- [`packages/coding-agent/src/core/tools/grep.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts)
- [`packages/coding-agent/src/core/tools/find.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts)
- [`packages/coding-agent/src/core/tools/ls.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/ls.ts)
- [`packages/coding-agent/src/core/tools/truncate.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/truncate.ts)
- [`packages/coding-agent/src/core/tools/path-utils.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/path-utils.ts)
- [`packages/coding-agent/src/core/tools/index.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/index.ts)
- [`packages/coding-agent/src/core/tools/render-utils.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/render-utils.ts)
- [`packages/coding-agent/src/core/tools/renderers/grep.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/grep.ts)
- [`packages/coding-agent/src/core/tools/renderers/find.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/find.ts)
- [`packages/coding-agent/src/core/tools/renderers/ls.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/ls.ts)
- [`packages/coding-agent/src/core/system-prompt.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/system-prompt.ts)
- [`packages/coding-agent/src/utils/paths.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/paths.ts)
- [`packages/coding-agent/src/utils/tools-manager.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts)
- [`packages/agent/src/agent-loop.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts)
- [`packages/coding-agent/test/tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts)
- [`packages/coding-agent/test/builtin-tool-strict-mode.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/builtin-tool-strict-mode.test.ts)
- [`docs/cli.md`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/cli.md)
- [`docs/settings.md`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/settings.md)
- [`docs/security.md`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/security.md)

ripgrep, pinned at 14.1.1 (`4649aa9700619f94cf9c66876e9549d83420e16c`) as the source for the cited
semantics; 15.2.0 was released before this snapshot, and Pi runs whichever version `ensureTool`
finds:

- [`crates/core/flags/defs.rs`](https://github.com/BurntSushi/ripgrep/blob/4649aa9700619f94cf9c66876e9549d83420e16c/crates/core/flags/defs.rs)
- [`GUIDE.md`](https://github.com/BurntSushi/ripgrep/blob/4649aa9700619f94cf9c66876e9549d83420e16c/GUIDE.md)

fd, pinned at 10.5.2 (`b2a287b3993768e0ec52f0852916917f23fb2a38`):

- [`doc/fd.1`](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/doc/fd.1)
- [`src/walk.rs`](https://github.com/sharkdp/fd/blob/b2a287b3993768e0ec52f0852916917f23fb2a38/src/walk.rs)

This repository:

- [`packages/tools/src/output-budget.ts`](../../packages/tools/src/output-budget.ts)
- [`packages/tools/src/workspace.ts`](../../packages/tools/src/workspace.ts)
- [`packages/tools/src/paths.ts`](../../packages/tools/src/paths.ts)
- [`packages/tools/src/tool-outcome.ts`](../../packages/tools/src/tool-outcome.ts)
