# Pi's edit tool: multi-edit contract, fuzzy matching, and diff output

## Snapshot and scope

Research snapshot: **2026-11-24**. The Pi repository tip used here is
[`8209929fb553e7a8c91dc0894569f9ec43dd201f`](https://github.com/earendil-works/pi/commit/8209929fb553e7a8c91dc0894569f9ec43dd201f), the `main` commit titled
`fix(coding-agent): correct the fallbacks for unsaved bash output files (#12461)`, dated
2026-11-24. Package metadata at this commit reports version `1.6.0` for `pi-coding-agent`
([`package.json`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/package.json#L3)); the `diff` dependency is pinned to `8.0.4`
([`package.json`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/package.json#L53)).

This note uses only Pi's source, its tests, and the published `diff` package. It feeds CDA-151
("Research Pi's edit contract, fuzzy matching and diff pipeline") and records what Pi does; it does
not decide this repository's contract.

Two implementations exist in Pi at this commit. The one in scope is
`packages/coding-agent/src/core/tools/edit.ts` and its helpers. A second, shorter copy lives in
`packages/durable/src/tools/edit.ts`; it copies arguments instead of mutating them
([`durable edit.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/durable/src/tools/edit.ts#L53)) and diffs whole files with `generateDiffString`
([`durable edit.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/durable/src/tools/edit.ts#L133-L136)) rather than the windowed `generateEditDiff`
described below. Citations here name the `coding-agent` package unless stated otherwise.

## Question

How does Pi's `edit` tool work end to end, so this repository can reproduce its multi-edit contract
and diff output? Specifically: the input schema and the repair of legacy or malformed model output,
exact-then-fuzzy matching and the rejection rules, BOM and line-ending handling on read and write,
the display diff and unified patch, the `details` payload and how a renderer receives it, the TUI
preview and colours, and what the model sees compared with what the UI sees.

## Short answer

- **Contract.** One call takes `path` plus a non-empty `edits` array of `{oldText, newText}`.
  Every `oldText` is matched against the **original** file, never incrementally; each must be
  unique and edits must not overlap; the whole call either applies or leaves the file untouched
  ([schema](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L29-L38), [`applyEditsToNormalizedContent`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L334-L342)).
- **Argument repair.** `prepareArguments` runs before schema validation. It accepts `edits` as a
  JSON string or as a single object, and folds a legacy top-level `oldText`/`newText` pair into the
  array ([legacy tests](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-legacy-input.test.ts#L92-L116), [why](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/extensions.md#L2318-L2320)).
- **Matching.** Exact `indexOf` first; only if that fails, both sides go through
  `normalizeForFuzzyMatch` (NFKC, trailing whitespace, smart quotes, Unicode dashes, special
  spaces). Uniqueness is counted in the normalized space and counts **non-overlapping**
  occurrences only ([rank order](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L250-L288), [count](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L290-L294)).
- **Rejections.** Empty `oldText`, no match, more than one occurrence, overlapping ranges, an empty
  `edits` array, or a replacement that changes nothing all fail with distinct messages. All
  matching happens before any write, so a matching failure cannot partially apply
  ([`execute`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L154-L214), [no-partial test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L474-L490)).
- **File handling.** Pi strips a leading BOM before matching and re-adds it on write; matches and
  replacements are computed on LF-normalized text; the result is spliced back into the original
  bytes so untouched lines keep their CRLF (or lone-CR) endings and inserted line breaks take the
  ending of the line they replace ([`applyReplacementsToOriginal`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L21-L56)).
- **Serialization and ordering.** A per-file queue keyed by `realpath` serializes mutations of the
  same file while different files run in parallel ([`file-mutation-queue.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/file-mutation-queue.ts#L28-L61)).
  The diff is computed before the write, so a diff failure cannot leave a written file
  ([order](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L193-L201), [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-diff-before-write.test.ts#L14-L29)).
- **Diff output.** `generateEditDiff` diffs only 32-line-margin windows around the replacements with
  jsdiff `8.0.4`, `context: 4`, producing a display diff (`+N`, `-N`, ` N`, `...`) and a
  unified patch whose headers are `--- path` / `+++ path`
  ([`generateEditDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L589-L626), [`FILE_HEADERS_ONLY`](https://github.com/kpdecker/jsdiff/blob/8.0.4/src/patch/create.ts#L18-L22)).
- **Details payload.** `execute` returns `content` = one sentence for the model and
  `details` = `{diff, patch, firstChangedLine?}` for the UI. `details` is stored in the session
  and passed to `renderResult`; it is not sent to the model ([`EditToolDetails`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L65-L72),
  [`convertToolResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/ai/src/api/anthropic-messages.ts#L1603-L1610)).
- **Renderer.** The TUI previews a diff while the call arguments are still arriving
  (`computeEditsDiff`, when `argsComplete`), then reuses the settled `details.diff` so the preview
  does not redraw; `renderDiff` colours context/removals/additions and inverse-highlights changed
  words when exactly one line is removed and one added ([`renderers/edit.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L173-L251),
  [`renderDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L87-L155)).

## 1. Tool surface

### Schema

```ts
Type.Object({
  path: Type.String(),                       // "relative or absolute"
  edits: Type.Array(Type.Object({
    oldText: Type.String(),                  // exact, unique, non-overlapping
    newText: Type.String(),
  })),
})
```

The public schema has only `path` and `edits`; the legacy fields are deliberately outside it
([`editSchema`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L29-L38)). `oldText`'s description requires it to be unique in the
original file and not to overlap any other edit; the `edits` description says each edit is matched
against the original, not incrementally, and that nearby changes should be merged into one edit
([`replaceEditSchema`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L18-L27), [`edits`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L32-L35)). The tool declares
`constrainedSampling: {type: "json_schema", strict: "prefer"}` ([`constrainedSampling`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L151)).

### What the model is told

The model sees the tool name `edit`, a one-paragraph description, the JSON schema above, a
one-line snippet in the "Available tools" section, and two guideline bullets in the system prompt's
rules section:

- description: "Edit a single file using exact text replacement. Every `edits[].oldText` must match
  a unique, non-overlapping region of the original file. If two changes affect the same block or
  nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large
  unchanged regions just to connect distant changes."
  ([`description`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L146-L147))
- snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits
  in one call" ([`snippet`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L41)).
- guidelines: "Use edit for targeted changes. Batch changes to one file in a single call." and
  "Each `edits[].oldText` must exactly and uniquely match the original file. Keep matches short and
  non-overlapping; merge nearby changes without including large unchanged regions."
  ([`guidelines`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L42-L46)).

Snippets and guidelines reach the prompt through `promptSnippet` / `promptGuidelines`
([`ToolDefinition`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/extensions/types.ts#L607-L610)): snippets are rendered under Available tools
([`buildSystemPromptSections`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/system-prompt.ts#L157-L160)) and guidelines become `- ` rule bullets
([`buildRules`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/system-prompt.ts#L118-L124), [`rules`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/system-prompt.ts#L161)).

### Argument repair (`prepareArguments`)

`prepareArguments` runs before schema validation and before `execute`
([`prepareToolCall`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L734-L736), [documented contract](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/extensions.md#L2318-L2320)).
It repairs three shapes models commonly send:

1. **`edits` as a JSON string.** `JSON.parse` it; an array is used directly, a single
   `{oldText, newText}` object is wrapped in `[ ]`. A string that is not JSON, or JSON of another
   shape, is left as-is for schema validation to reject ([`prepareEditArguments`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L105-L115);
   [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-legacy-input.test.ts#L92-L116)). The comment names Opus 4.6 and GLM-5.1 as models seen doing
   this ([`edit.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L105-L106)).
2. **`edits` as a single edit object** instead of an array: wrapped in `[ ]`
   ([`isSingleEditInput`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L56-L63), [`prepareEditArguments`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L116-L118)).
3. **Legacy top-level `oldText`/`newText`.** When both are strings, they are appended to a copy of
   any existing `edits` array and removed from the returned object
   ([`prepareEditArguments`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L120-L128)). This exists because an older session may hold
   a tool call in the old shape ([docs](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/extensions.md#L2320)) and because the schema must stay
   strict ([`legacy tests`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-legacy-input.test.ts#L20-L72)).

Shape details worth knowing: the string repair mutates `args.edits` in place, so the returned
object is identical to the input and the caller keeps it ([`prepareToolCallArguments`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L694-L706));
the legacy fold returns a new object and removes the old keys, so the recorded call keeps the old
shape while the executed call uses the repaired one. `file_path` is never repaired here — the
renderer accepts it as an alias, but the tool schema does not
([`getRenderablePreviewInput`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L59-L82)).

After repair, a missing or empty `edits` array is rejected inside `execute`:
"Edit tool input is invalid. edits must contain at least one replacement."
([`validateEditInput`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L131-L136), [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L447-L457)).

## 2. Matching

### Order of operations

`applyEditsToNormalizedContent` is the whole matcher; it never touches the filesystem:

1. Normalize every `oldText` and `newText` to LF ([`normalizedEdits`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L348-L351)).
2. Reject an empty `oldText` for each edit, with a per-edit or single-edit message
   ([`empty check`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L353-L357)).
3. Probe every edit with `fuzzyFindText` against the LF content. If **any** edit needed fuzzy
   matching, the base for all edits becomes `normalizeForFuzzyMatch(content)`
   ([`initialMatches`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L359-L361)).
4. Re-run `fuzzyFindText` for each edit against that base; a miss throws "not found"
   ([`matchedEdits`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L363-L374)).
5. Count occurrences of each `oldText` in the base; more than one throws "duplicate"
   ([`countOccurrences`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L371-L374)).
6. Sort matches by index and reject any pair whose ranges overlap
   ([`overlap check`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L384-L393)).
7. Build replacements: exact matches are used as-is; fuzzy matches are widened to whole lines
   ([`widenReplacementsToLines`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L395-L398)).
8. Apply replacements in reverse offset order to the LF base; if the result equals the base, throw
   "no change" ([`applyReplacements`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L155-L164), [`no change`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L401-L403)).

### Exact, then fuzzy

`fuzzyFindText` returns the exact offset and `oldText.length` when `content.indexOf(oldText)` hits;
otherwise it searches `normalizeForFuzzyMatch(content).indexOf(normalizeForFuzzyMatch(oldText))` and
reports `usedFuzzyMatch: true` plus the normalized content for replacement
([`fuzzyFindText`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L250-L288)). The exact path is preferred, so a file that contains both
an exact and a fuzzy-only match uses the exact one ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1673-L1686)).

`normalizeForFuzzyMatch` applies, in order ([`edit-diff.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L77-L98)):

| Step | Transformation | Examples |
|---|---|---|
| 1 | Unicode NFKC | `ＡＢＣ１２３` → `ABC123`, `cafe` + U+0301 → `café` ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1595-L1607)) |
| 2 | `trimEnd()` on every line | trailing spaces dropped ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1565-L1579)) |
| 3 | Smart single quotes U+2018–U+201B → `'` | [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1609-L1623) |
| 4 | Smart double quotes U+201C–U+201F → `"` | [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1625-L1639) |
| 5 | U+2010–U+2015 and U+2212 → `-` | en/em dash, minus ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1641-L1655)) |
| 6 | U+00A0, U+2002–U+200A, U+202F, U+205F, U+3000 → space | NBSP and friends ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1657-L1671)) |

This changes lengths (NFKC, trimming), which is why fuzzy matches cannot be mapped offset-for-offset
onto the original bytes.

### Occurrence counting and uniqueness

`countOccurrences` is `normalizeForFuzzyMatch(content).split(normalizeForFuzzyMatch(oldText)).length - 1`
([`countOccurrences`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L290-L294)). Two consequences:

- Uniqueness is judged in **fuzzy space even when the match was exact**, so
  `"hello world   \nhello world\n"` is a duplicate for `oldText: "hello world"`
  ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1700-L1711)).
- `split` counts non-overlapping placements. Pi treats `"aaa"` with `oldText: "aa"` as a single
  match and replaces the first `aa`, while `"aaaa"` is ambiguous. (Reproduced by running the
  pinned `applyEditsToNormalizedContent`.) This differs from this repository's current matcher,
  which counts every placement, overlapping ones included
  (`packages/tools/src/edit.ts:171-181`).

Tests cover fuzzy duplicates and fuzzy multi-edit:
[duplicates](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1700-L1711), [multi-edit fuzzy](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1713-L1726).

### Overlap

After sorting by `matchIndex`, edits are rejected when
`previous.matchIndex + previous.matchLength > current.matchIndex`. Adjacent ranges (end == next
start) are allowed; identical ranges are rejected by the same check
([`overlap check`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L384-L393), [test: adjacent succeeds](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L459-L472)).
The message always names both edits and the file
([`overlap message`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L389-L391)):

```
edits[i] and edits[j] overlap in {path}. Merge them into one edit or target disjoint regions.
```

### Empty `oldText` and no-change

- Empty (after LF normalization) is rejected before any matching; only the **empty string** is
  checked, so whitespace-only targets are allowed
  ([`getEmptyOldTextError`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L318-L323)).
- `baseContent === newContent` after applying all replacements is an error, which catches a
  no-op single edit and an all-no-op multi-edit. A call where some edits are no-ops and at least one
  changes text succeeds, and the success message still counts every edit
  ([`getNoChangeError`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L325-L332), [verified behaviour](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L401-L403)).
- `newText: ""` is a legal deletion; an empty `edits` array is not a legal call.

### Exact error strings

Built by four helpers, which pick a single-edit or multi-edit wording
([error builders](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L296-L332)):

| Situation | Single edit | Multiple edits |
|---|---|---|
| empty `oldText` | `oldText must not be empty in {path}.` | `edits[{i}].oldText must not be empty in {path}.` |
| not found | `Could not find the exact text in {path}. The old text must match exactly including all whitespace and newlines.` | `Could not find edits[{i}] in {path}. The oldText must match exactly including all whitespace and newlines.` |
| duplicate | `Found {n} occurrences of the text in {path}. The text must be unique. Please provide more context to make it unique.` | `Found {n} occurrences of edits[{i}] in {path}. Each oldText must be unique. Please provide more context to make it unique.` |
| no change | `No changes made to {path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.` | `No changes made to {path}. The replacements produced identical content.` |
| overlap | — | `edits[{i}] and edits[{j}] overlap in {path}. Merge them into one edit or target disjoint regions.` |
| bad call | `Edit tool input is invalid. edits must contain at least one replacement.` | same |
| file access | `Could not edit file: {path}. {Error code: CODE}` or `... {String(error)}.` | same |

The single-edit "not found" wording still says "exact" even though fuzzy matching was attempted, and
single-edit errors use "old text" where multi-edit errors use `oldText`; these strings are
model-visible, so they are quoted verbatim here. They were confirmed by running the pinned code for
each case.

### Fuzzy widening

A fuzzy match's offsets are in normalized space. Pi then widens each replacement to the whole lines
it touches in the normalized base, groups replacements whose line ranges touch, rewrites only those
lines from the normalized base, and leaves every other line alone
([`widenReplacementsToLines`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L166-L214)). It refuses to do so if the original and fuzzy
base disagree on line count ("Cannot preserve unchanged lines because the base content has a
different line count."), which normalization cannot normally cause because it preserves `\n`
([guard](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L183-L185)). The widened replacement's `newText` is built from the normalized
base, so the diff and the written text agree on everything the edit replaced
([tests](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1743-L1777)).

## 3. File handling

### Read, BOM, LF

`execute` resolves the path against the extension context's `cwd` (or the tool's), enters the
per-file queue, checks `R_OK | W_OK`, reads the file as a Buffer, and decodes UTF-8
([`execute`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L154-L183), [`defaultEditOperations`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L87-L91),
[`resolveToCwd`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/path-utils.ts#L48-L50)). Then:

```ts
const { bom, text: content } = splitBom(rawContent); // strip a leading U+FEFF
const normalizedContent = normalizeToLF(content);     // CRLF -> LF, lone CR -> LF
```

([`splitBom`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L185-L187), [`normalizeToLF`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L11-L13),
[`splitBom` implementation](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/text.ts#L1-L4)). The model is
not expected to include an invisible BOM in `oldText`, hence the strip; the BOM is prepended again
on write ([`edit.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L185-L186), [`finalContent`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L199-L200)). LF
normalization also turns a lone CR into LF for matching, but the write-back path preserves it (see
below) ([test: lone CR kept](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1921-L1928)).

### Write-back: `applyReplacementsToOriginal`

Rather than writing the normalized result, Pi splices the replacements back into the original text:

- `content === normalizedContent` means the file had no CR at all, so `newContent` is already
  byte-identical in line endings and is written directly. Otherwise the original text is patched
  ([`finalContent`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L197-L201)).
- `applyReplacementsToOriginal` maps each normalized offset to the original by adding the number of
  CRLFs before it, because only CRLF changes length when normalizing; a lone CR maps one-to-one
  ([`toOriginal`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L22-L33)).
- For each replacement it takes the line ending of the line where the range starts and rewrites
  every `\n` in `newText` to that ending, so inserted lines match the line they replace
  ([`getLineEndingAt`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L58-L68), [`loop`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L46-L55)). In a file with no LF at
  all, a lone CR is the line ending; elsewhere a lone CR is treated as content, not a break
  ([`getLineEndingAt`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L63-L67)).
- A seam guard inserts one extra `\n` when a kept lone CR meets inserted text starting with `\n`,
  so the two do not merge into a CRLF ([`push`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L35-L45), [seam tests](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1956-L1973)).

The invariant, asserted by randomized mixed-ending tests, is: `normalizeToLF(written) === newContent`
for every case that applies, and untouched regions keep their original bytes
([randomized test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1982-L2008)). Examples from the suite:

| Input bytes | Edit | Output bytes |
|---|---|---|
| `first\r\nsecond\r\nthird\r\n` | `second\n` → `REPLACED\n` | `first\r\nREPLACED\r\nthird\r\n` ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1805-L1816)) |
| `first\r\nsecond\r\nthird` (CRLF, no final newline) | `second\nthird` → `2a\r\n2b\nthird!` | `first\r\n2a\r\n2b\r\nthird!` ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1873-L1883)) |
| `a\rb\nX = 1\n` (lone CR inside line 1) | `X = 1` → `X = 2` | `a\rb\nX = 2\n` ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1921-L1928)) |
| `\uFEFFfirst\r\nsecond\r\nthird\r\n` | `second\n` → `REPLACED\n` | BOM kept, CRLF kept ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1844-L1855)) |

Because the diff is computed on the LF-normalized base and new content, the display diff never shows
`\r`, and it matches the preview diff exactly even for CRLF files.

### The file mutation queue

`withFileMutationQueue(path, fn)` serializes calls for the same resolved file and lets different
files proceed in parallel ([doc comment](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/file-mutation-queue.ts#L28-L31)). The key is `realpath(resolve(path))`
where the file exists and `resolve(path)` where it does not (`ENOENT`/`ENOTDIR`), so a missing file
still gets a stable key ([`getMutationQueueKey`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/file-mutation-queue.ts#L16-L26)). Registration itself is
serialized through `registrationQueue` so two concurrent callers cannot both see an empty slot
([`withFileMutationQueue`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/file-mutation-queue.ts#L32-L49)). The queue tail is deleted when the last waiter
finishes ([`finally`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/file-mutation-queue.ts#L53-L60)).

### Abort and ordering

Pi avoids rejecting from an abort listener, which would release the queue while an in-flight
filesystem operation might still finish. Instead it checks `signal.aborted` after each await, and
the check is placed **after** the write too, so an abort in that window throws after the file has
changed ([`throwIfAborted`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L159-L202)). Operations run: check aborted → access check →
read → strip/normalize → match → diff → abort check → write → abort check
([`execute`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L154-L214)). The diff runs before the write explicitly "so diff computation
cannot fail after the write" ([`comment`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L193-L194), [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-diff-before-write.test.ts#L14-L29)).

### What Pi does not do here

- It writes through `writeFile` on the target path (truncating), with no temporary file or rename
  ([`defaultEditOperations`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L87-L91)); atomicity is this repository's addition
  (`packages/tools/src/atomic-write.ts`).
- It decodes with `Buffer.toString("utf-8")`, which replaces invalid bytes rather than failing
  ([`read`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L180-L183)); this repository rejects invalid UTF-8 and binary files
  (`packages/tools/src/text-file.ts:62-70`).
- The read path has no UTF-8 validity, binary, or size check: any file is decoded and a large file
  is read whole, though diffing is windowed ([window margin](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L578-L587)).

## 4. Diff

### Display diff format

`generateDiffString` and the windowed `generateEditDiff` share `formatDisplayDiff`, which turns
jsdiff `diffLines` parts into lines with a one-character prefix, a padded line number, a space, and
the text ([`formatDisplayDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L450-L569)):

| Kind | Format | Number used |
|---|---|---|
| added | `+{new line number} {text}` | new file |
| removed | `-{old line number} {text}` | old file |
| context | ` {old line number} {text}` | **old** file |
| skipped | ` {width spaces} ...` | — |

Two details matter for reproducing it. Context and removed lines are numbered from the **old** file;
only added lines use the new numbering, so after an insertion the context line numbers lag the new
file by the number of inserted lines. The width is `String(max(countLines(old), countLines(new))).length`,
so all numbers in one diff share a column width ([`lineNumWidth`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L425),
[`countLines`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L436-L439)). Context around a change is capped at `contextLines`, default
4; longer unchanged runs collapse to a `...` marker, and runs with context on both sides keep 4
lines at each end ([`context`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L497-L557)).

Real output of the pinned code for a 12-line file, editing lines 2 and 10 (line 10 also gains a
line), from `generateEditDiff`:

```
  1 line 1
- 2 line 2
+ 2 LINE TWO
  3 line 3
  4 line 4
  5 line 5
  6 line 6
  7 line 7
  8 line 8
  9 line 9
-10 line 10
+10 LINE TEN
+11 extra
 11 line 11
 12 line 12
```

There is no `...` here: the unchanged run between the two changes is 7 lines, at most twice the
4-line context, so `formatDisplayDiff` shows all of it
([`hasLeadingChange && hasTrailingChange`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L497-L527)). `firstChangedLine` was `2`. The
same fixture with edits at lines 100 and 500 of a
600-line file produced 4 context lines around each change and a `...` marker before the first
change, between the two changes, and after the last change; the patch had two hunks
(`@@ -96,9 +96,9 @@`, `@@ -496,9 +496,9 @@`). `EditToolDetails.firstChangedLine` is the 1-based line
of the first added or removed line in the new file, set from the first window that has a change
([`firstChangedLine`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L471-L475), [`??=`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L611)).

### Windowing

`generateEditDiff` does not diff the whole file. For each replacement (sorted, disjoint) it builds a
window from the start of the line containing the match, extended 32 lines back, to the end of the
line 32 lines after the match end; windows that touch or overlap are merged
([`DIFF_WINDOW_MARGIN_LINES`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L578-L582), [`getDiffWindows`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L644-L687)).
Each window is `diffLines`-ed and `structuredPatch`-ed with `context: contextLines` (default 4),
then hunk offsets are shifted by the window's absolute line numbers and the hunks are concatenated
([`generateEditDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L589-L626)). When two adjacent windows both start or end with the
`...` marker, one is dropped so the result looks like a single whole-file diff
([`dedupe`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L612-L613)).

The stated tradeoff: the output matches a whole-file `generateDiffString`/`generateUnifiedPatch`
when lines are distinct, but jsdiff may align runs of repeated lines differently inside a window
([`comment`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L584-L588)). The tests assert exact equality for random distinct-line cases
and only "patch applies" for repeated-line cases, plus a 20 MB file diffed under a 96 MB heap
([window tests](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-diff-window.test.ts#L54-L107)).

### Unified patch

- Per window, Pi calls `Diff.structuredPatch(path, path, oldText, newText, undefined, undefined, {context})`
  and shifts `oldStart`/`newStart` by the window offset ([`patch hunk`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L616-L619)).
- It serializes the hunks with `Diff.formatPatch(patch, Diff.FILE_HEADERS_ONLY)`, where `patch` is
  `{oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks}`
  ([`formatPatch`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L621-L624)).
- `FILE_HEADERS_ONLY` = `{includeIndex: false, includeUnderline: false, includeFileHeaders: true}`,
  so the patch starts with `--- path` and `+++ path` and has no `Index:` or `===` lines
  ([`jsdiff constants`](https://github.com/kpdecker/jsdiff/blob/8.0.4/src/patch/create.ts#L13-L27), [README](https://github.com/kpdecker/jsdiff/blob/8.0.4/README.md#L121-L130)).
- `generateUnifiedPatch` exists for whole-file patches via `createTwoFilesPatch` with the same
  options ([`generateUnifiedPatch`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L408-L414)); the edit tool itself does not call it.
- The `path` in the headers is the model-supplied path, not the resolved absolute path or a
  repository-relative one ([`generateEditDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L589-L595)).

### jsdiff version and API

Pi pins `diff` **8.0.4** ([`package.json`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/package.json#L53)). The functions Pi uses are:

| API | Use | Citation |
|---|---|---|
| `diffLines(old, new)` | display diff parts | [formatDisplayDiff](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L426-L432) |
| `structuredPatch(oldFile, newFile, oldStr, newStr, oldHeader, newHeader, {context})` | per-window hunks | [patch](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L616) |
| `formatPatch(structuredPatch, headerOptions)` | serialize hunks | [patch](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L621) |
| `createTwoFilesPatch(...)` | `generateUnifiedPatch` | [unified](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L409-L413) |
| `diffWords(old, new)` | renderer intra-line highlighting | [renderIntraLineDiff](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L36) |
| `applyPatch(content, patch)` | tests verify the written text | [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L351) |

jsdiff's own default `context` is also 4 when omitted
([`create.ts`](https://github.com/kpdecker/jsdiff/blob/8.0.4/src/patch/create.ts#L140-L142)), and `formatPatch` defaults to `INCLUDE_HEADERS` when no
header options are given ([`formatPatch`](https://github.com/kpdecker/jsdiff/blob/8.0.4/src/patch/create.ts#L279-L282)), so Pi passes its options
explicitly.

## 5. Details payload and renderer

### `EditToolDetails`

```ts
interface EditToolDetails {
  diff: string;              // display-oriented diff
  patch: string;             // standard unified patch
  firstChangedLine?: number; // 1-based line in the new file
}
```

([`EditToolDetails`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L65-L72)). The value `execute` actually returns is `EditDiff`, which
has the same three fields with `firstChangedLine: number | undefined`
([`EditDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L571-L576), [return](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L204-L212)). Nothing in the coding-agent source
reads `details.patch` at this commit; its consumers are tests that apply it with `applyPatch` to prove
the written file equals the diffed file ([`tools.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1740), [`1776`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1776)).

On success the model-facing `content` is exactly
`Successfully replaced {edits.length} block(s) in {path}.` — the count is the number of edits, not
the number of occurrences, and `path` is the argument as given
([`return`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L204-L212)). On failure the thrown error becomes
`content: [{type:"text", text: message}]` with `isError: true` and `details: {}`
([`createErrorToolResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L915-L920), [`catch`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L848-L857)).

### How `details` reaches the renderer

1. `execute` resolves `{content, details}` ([`edit.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit.ts#L204-L212)).
2. The agent loop wraps it in a `ToolResultMessage` that carries `details`
   ([`createToolResultMessage`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L933-L945); the message shape is documented in
   [`ToolResultMessage`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/message-types.md#L161-L177)) and emits it.
3. The session stores the whole message, so `details` is written to the session JSONL with the
   entry ([`appendMessage`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/session-manager.ts#L1224-L1234), [`_persist`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/session-manager.ts#L1185-L1198)).
4. The TUI's `ToolExecutionComponent` keeps `result.details` and calls
   `renderer({content, details}, {expanded, isPartial}, theme, context)`
   ([`result`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L59-L64), [`resultRenderer`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/tool-execution.ts#L316-L344)).
5. `renderResult` reads `result.details?.diff` and `firstChangedLine`
   ([`renderResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L205-L251)).

`details` never enters the model request: the provider adapters convert a tool result from
`content` and `isError` only ([`convertToolResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/ai/src/api/anthropic-messages.ts#L1603-L1610)), and the tool result
type describes `content` as "returned to the model" versus `details` as "for logs or UI rendering"
([`AgentToolResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/types.ts#L424-L446)). The Markdown export path also passes `details`
into `renderResult` ([`tool-renderer.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/export-html/tool-renderer.ts#L124-L166)),
so the diff survives non-interactive rendering.

### Preview: `computeEditsDiff`

The renderer computes a dry-run diff while the call is being drawn, before execution:

- **When.** On `renderCall`, only if `context.argsComplete` is true (arguments fully streamed), a
  renderable `{path, edits}` exists, and no preview is already present or pending. The preview key is
  `JSON.stringify({path, edits})`; a new key clears the preview and `settledError`
  ([`renderCall`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L174-L195)). It is fire-and-forget (`void ...then`) and calls
  `context.invalidate()` when it settles ([`renderCall`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L186-L195)).
- **What it runs.** `computeEditsDiff(path, edits, cwd)` re-reads the file, strips the BOM,
  LF-normalizes, runs the same matcher as `execute`, and returns `{diff, firstChangedLine}` or
  `{error}`; it never writes ([`computeEditsDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/edit-diff.ts#L702-L732)). A missing file returns
  `Could not edit file: {path}. Error code: ENOENT.` ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L524-L528)).
- **What it shows.** Inside the edit call box: a spacer and the display diff, or the error text in
  red. The box background is `toolSuccessBg` when a preview exists without an error,
  `toolErrorBg` on a preview error or a settled error, and `toolPendingBg` otherwise
  ([`buildEditCallComponent`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L131-L152), [`getEditHeaderBg`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L115-L130)).
- **Which args it accepts.** `path` or `file_path`, plus either a non-empty valid `edits` array or
  the legacy `oldText`/`newText` pair — because `renderCall` sees the raw streamed arguments, which
  have not passed through `prepareArguments`
  ([`getRenderablePreviewInput`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L59-L82), [raw args emitted](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/agent/src/agent-loop.ts#L549-L557)).

When the result settles, `renderResult` feeds `details.diff` into the same preview state
([`setEditPreview`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L153-L171), [`renderResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L210-L219)), so a
successful edit does not redraw and a replayed session (no `argsComplete`, no file) still shows the
diff ([test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-no-full-redraw.test.ts#L153-L200)). The result diff is rendered in a separate result region
only when there is no call component to hold it, for example a replayed transcript; the success
sentence is not rendered in either case
([`formatEditResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L87-L114), [test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-no-full-redraw.test.ts#L80-L151)). On error, the error
text is shown in red unless it is identical to the preview's error, in which case only the preview
shows it ([`formatEditResult`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/renderers/edit.ts#L97-L106), [error preview test](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-no-full-redraw.test.ts#L202-L235)).

### `renderDiff`

`renderDiff` parses each diff line with `/^([+-\s])(\s*\d*)\s(.*)$/`, groups consecutive
removals followed by consecutive additions, and colours by theme token
([`renderDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L87-L155), [`parseDiffLine`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L8-L12)):

| Line | Colour token | Theme value (dark / light) |
|---|---|---|
| removed `-N text` | `toolDiffRemoved` | `red` ([dark](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/dark.json#L52-L54), [light](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/light.json#L52-L54)) |
| added `+N text` | `toolDiffAdded` | `green` |
| context ` N text` | `toolDiffContext` | `muted` |
| unparsable | `toolDiffContext` | `muted` |

The token definitions and fallback ("readable" against the tool panel background) are in
[`theme-tokens.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/theme-tokens.ts#L77-L79) and [`system-theme.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/system-theme.ts#L92).

When a run has exactly one removed and one added line, `renderIntraLineDiff` highlights changed
words with `theme.inverse`: it first keeps common leading indentation out of the comparison, then
diffs the rest with `diffWords`, moving leading whitespace of the first removed/added part outside
the inverse span ([`renderIntraLineDiff`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L25-L74), [`inverse`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/theme/theme.ts#L326-L328)).
Tabs are replaced with three spaces for diffing and rendering
([`replaceTabs`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L16-L19)). Runs with any other shape are shown line by line without
intra-line highlighting ([`else`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L134-L141)). The skip marker parses as a context
line whose content is `...`, so it is rendered dim
([`marker parse`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/components/diff.ts#L8-L12)). Running the
parser on the marker `"     ..."` returns `{prefix:" ", lineNum:"   ", content:"..."}`, so the marker
keeps its indentation and is coloured as context.

## 6. The tests as a second specification

The suite pins behaviour that the prose above only summarises:

- Multi-edit on disjoint regions, and matching against the original rather than incrementally:
  [`tests`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L391-L445).
- Empty `edits`, overlap rejection, and no partial application when one edit fails:
  [`tests`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L447-L490).
- Large unchanged gaps collapse (600-line file, three edits, fewer than 50 diff lines):
  [`test`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L409-L430).
- Fuzzy matching for trailing whitespace, CJK punctuation, compatibility forms, quotes, dashes, and
  spaces: [`tests`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1565-L1671).
- BOM and CRLF preservation, mixed endings, lone CR, and inserted-line endings:
  [`tests`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools.test.ts#L1780-L2008).
- Legacy/string/single-object argument repair before validation:
  [`edit-tool-legacy-input.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-legacy-input.test.ts#L20-L116).
- Windowed diff equals whole-file diff on distinct lines; patch applies on repeated lines; 20 MB
  file under a 96 MB heap: [`edit-diff-window.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-diff-window.test.ts#L54-L107).
- Diff computed before write, so a diff failure leaves the file untouched:
  [`edit-tool-diff-before-write.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-diff-before-write.test.ts#L14-L29).
- Preview/replay rendering and error previews: [`edit-tool-no-full-redraw.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/edit-tool-no-full-redraw.test.ts#L80-L235).

## Open questions for this repo

These are questions, not decisions; each names the current behaviour it would touch.

1. **Where does a diff live in a Tool Outcome?** This repo's `ToolOutcome` carries `content`,
   `isError`, `error`, and an optional `truncated`, but no details channel
   (`packages/agent-core/src/tool.ts:27-34`), and `success()`
   only takes a string (`packages/tools/src/tool-outcome.ts:5-13`). Pi keeps a separate `details`
   channel that the session and renderer read but the model does not. Does adding a details/metadata
   channel belong in Agent Core, or should the diff be carried outside the Tool Result?
2. **Single target versus `edits[]`.** The current schema is `path`, `targetContent`,
   `replacementContent` with `minLength: 1` (`packages/tools/src/edit.ts:17-28`). Adopting
   multi-edit changes the declared shape, the Approval summary (`edit.ts:65-74`), and the success
   text (`edit.ts:90-92`). Is the old shape kept as an alias, and if so where is it normalized,
   given that this repo validates before `prepare` (`packages/agent-core/src/tool-call-preflight.ts:89-109`)
   whereas Pi repairs before validation?
3. **Overlapping occurrences.** This repo counts every placement, so `"aaa"` with target `"aa"` is
   `AMBIGUOUS_MATCH` (`packages/tools/src/edit.ts:171-181`, `packages/tools/tests/edit.test.ts:217-232`).
   Pi counts non-overlapping placements and would apply that edit. Which rule does the multi-edit
   contract state, and does it stay consistent with the existing error codes?
4. **CRLF matching.** Pi normalizes to LF for matching and splices back; this repo matches the raw
   decoded text, so an `oldText` using LF does not match a CRLF file, and the edit tool has no CRLF
   tests (only `read` keeps CRLF in its output, `packages/tools/tests/read.test.ts:152-158`). Does
   the new contract match LF-normalized text, and if so is the write-back splice mandatory to keep
   untouched lines byte-identical?
5. **BOM ownership.** This repo decodes with `ignoreBOM: true`, so a BOM stays a character and a
   target that starts at the first character must not include it (`packages/tools/src/text-file.ts:62-67`,
   `packages/tools/tests/edit.test.ts:396-407`). Pi strips it before matching and prepends it on
   write. Which behaviour should the fuzzy matcher see, and what happens when `newText` itself
   begins with U+FEFF?
6. **Fuzzy normalization scope.** Pi applies NFKC, which can change characters inside string
   literals and identifiers (`ＡＢＣ` → `ABC`, fullwidth punctuation). Is NFKC acceptable for this
   project's language-agnostic positioning, or should the fallback be limited to whitespace and
   quote/dash/space folding?
7. **Diff implementation.** This repo has no diff dependency (`packages/tools/package.json` lists
   only `@coding-agent/agent-core` and `typebox`) and no diff renderer. Does reproducing Pi's output
   mean taking `diff@8.0.4` and its `structuredPatch`/`formatPatch`/`FILE_HEADERS_ONLY` API, or
   emitting a display diff only and skipping the unified patch?
8. **Display numbering.** Pi numbers context and removed lines from the old file and added lines from
   the new file, so after an insertion the context numbers do not match the new file. Is that quirk
   part of what we want to reproduce, or do we want one consistent numbering?
9. **Where the diff is shown when there is no preview.** This repo shows the diff after execution
   only. Pi's renderer suppresses the result-region diff when a preview exists
   (`packages/coding-agent/src/core/tools/renderers/edit.ts:108-111`), so its post-execution path is
   the one without a call component. Which component owns the diff once execution settles, and does
   the Approval summary (`prepare`) stay diff-free?
10. **Atomic write versus in-place write.** Pi writes with `writeFile` on the target and computes the
    diff before writing; this repo writes through a temporary file and rename
    (`packages/tools/src/edit.ts:85-89`, `packages/tools/src/atomic-write.ts`). If the diff is
    computed from the pre-write content, does the existing prepare/execute split give a safe place to
    compute it without re-reading after Approval?

## Sources

Pi, pinned at `8209929fb553e7a8c91dc0894569f9ec43dd201f` (2026-11-24, `pi-coding-agent` `1.6.0`):

- `packages/coding-agent/src/core/tools/edit.ts` — tool definition, schema, argument repair,
  read/write pipeline, `EditToolDetails`.
- `packages/coding-agent/src/core/tools/edit-diff.ts` — normalization, matching, widening,
  display diff, windowed diff, patch, preview.
- `packages/coding-agent/src/core/tools/file-mutation-queue.ts` — per-file serialization.
- `packages/coding-agent/src/core/tools/renderers/edit.ts` — call/result renderers and preview.
- `packages/coding-agent/src/modes/interactive/components/diff.ts` — `renderDiff` and intra-line
  highlighting.
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` — renderer invocation
  and `details` handoff.
- `packages/coding-agent/src/modes/interactive/theme/{dark.json,light.json,system-theme.ts,theme-tokens.ts,theme.ts}`
  — diff colours and `inverse`.
- `packages/agent/src/agent-loop.ts` — `prepareArguments` ordering, tool result messages, error
  results.
- `packages/agent/src/types.ts` — `AgentToolResult`.
- `packages/ai/src/api/anthropic-messages.ts` — `convertToolResult` (content and `isError` only).
- `packages/coding-agent/src/core/session-manager.ts` — session persistence of `details`.
- `packages/coding-agent/docs/message-types.md`, `docs/extensions.md` — tool result shape and
  `prepareArguments` rationale.
- `packages/coding-agent/test/{tools.test.ts,edit-tool-legacy-input.test.ts,edit-diff-window.test.ts,edit-tool-diff-before-write.test.ts,edit-tool-no-full-redraw.test.ts}`
  — executable expectations.
- `packages/durable/src/tools/edit.ts` — the parallel implementation, for contrast.

`diff` (jsdiff) 8.0.4, pinned by `packages/coding-agent/package.json` L53:

- `src/patch/create.ts` at tag `8.0.4` — header option constants, default `context`, `formatPatch`.
- `README.md` at tag `8.0.4` — `createTwoFilesPatch`, `headerOptions`, `FILE_HEADERS_ONLY`.

This repository (for the open questions):

- `packages/tools/src/edit.ts` — current single-target matcher and success text.
- `packages/tools/src/text-file.ts` — BOM handling and strict UTF-8 decoding.
- `packages/tools/src/atomic-write.ts` — atomic replace used by `execute`.
- `packages/tools/src/tool-outcome.ts` — `success`/`toolError` shape.
- `packages/agent-core/src/tool.ts` — `ToolOutcome` type.
- `packages/agent-core/src/tool-call-preflight.ts` — validation before `prepare`.
- `packages/tools/tests/edit.test.ts`, `packages/tools/tests/read.test.ts` — current expectations.
