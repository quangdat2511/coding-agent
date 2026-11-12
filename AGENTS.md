## Synchronization

`AGENTS.md` is the source of truth for repository guidance, and `CLAUDE.md` is a symlink to it.
Edit `AGENTS.md` and preserve the symlink so both entry points always expose identical guidance.

## Project

Coding Agent — a CLI-based AI coding agent that takes natural-language requests and performs
general-purpose programming tasks (code generation, bug fixing, review assistance) grounded in
real codebase context. This is a university final-year project (Đồ án tốt nghiệp, HCMUS). The
target architecture has controlled components: Agent Runtime, Context Intelligence, Planning,
Verification, Safety, and Memory, and is designed to be language-agnostic (relies on the base
LLM's code understanding rather than per-language parsers).

The codebase is currently in early scaffolding: a Bun/TypeScript monorepo with a single
`packages/ai` workspace package containing placeholder code.

### Reference architecture: Pi

This project is modeled on [Pi](https://github.com/earendil-works/pi) (`earendil-works/pi`), an
open-source AI agent toolkit, and is benchmarked against TerminalBench under the same conditions
as Pi (see README). Pi is relevant background for design decisions here:

- Pi ships as a set of independent packages: `pi-ai` (unified multi-provider LLM API — OpenAI,
  Anthropic, Google, etc.), `pi-agent-core` (agent runtime/loop with tool calling and state
  management), `pi-tui` (terminal UI components), and `pi-coding-agent` (the CLI that composes
  them). This repo's `packages/ai` corresponds to Pi's `pi-ai` role: a model-agnostic LLM
  provider abstraction, matching the multi-provider goal in the tech stack table below
  (`AGENT_PROVIDER` / `OPENROUTER_API_KEY` / etc. in `.env.example`) rather than a
  single-provider integration.
- Pi's design philosophy is a deliberately minimal core (four basic tools: read, write, edit,
  bash) kept extensible via TypeScript extensions/skills rather than baking features into the
  core — expect this repo to favor the same "small core + extensions" shape as it grows, rather
  than a monolithic agent package.
- Don't assume 1:1 API compatibility with Pi's packages — treat it as the architectural reference
  point, not a dependency; verify against Pi's actual source before assuming a specific interface.

## Commands

This is a Bun workspace monorepo (`packages/*`). Run all commands from the repo root.

- `bun install` — install dependencies (also runs `lefthook install` via postinstall)
- `bun test` — run all tests (Bun's built-in test runner, uses `bun:test`)
- `bun test <path>` — run a single test file
- `bun --filter '*' typecheck` — typecheck all workspace packages (each package defines its own `typecheck` script, e.g. `tsc --noEmit`)
- `biome check .` — lint + format check (Biome, not ESLint/Prettier)
- `biome check --write .` — lint + format, autofixing
- `biome format --write .` — format only

There is no build step defined yet.

**Platforms**: Linux, macOS, and Windows. Windows follows Pi's native-Windows approach: Git Bash,
MSYS, Cygwin, and WSL drive paths are normalized before resolution, junctions are rejected like
symbolic links, and the future `bash` tool should resolve Git Bash first with an optional
PowerShell tool, without requiring WSL. Windows-specific path handling is unit-tested on every
host, and CI runs the test suite on Linux, macOS and Windows. A test that cannot run on Windows
is skipped there with `skipIf` and a comment giving the reason, usually on its guard constant in
the package's `platform.ts` (`packages/tools/tests/platform.ts`,
`packages/coding-agent/tests/support/platform.ts`). The `coding-agent` bin
entry does not start on Windows: Bun's Windows bin shim cannot run its `env -S` shebang, and Bun
there accepts no empty device as `--config`. On Windows, run the executable compiled with
`--no-compile-autoload-dotenv --no-compile-autoload-bunfig` instead (see
`packages/coding-agent/README.md`).

## Architecture

- **Monorepo layout**: root `package.json` declares `workspaces: ["packages/*"]`. Each package
  under `packages/` is an independent workspace with its own `package.json` and `tsconfig.json`
  extending the root `tsconfig.base.json`.
- **`packages/ai`**: the first (and currently only) package (`@coding-agent/ai`). Entry point is
  `src/index.ts`.
- **Imports**: within a package, import its own files by relative path with the source extension
  (`./types.ts`, `../api/openai-responses.ts`, `./render.tsx`, `./anthropic.models.json`); import
  another package only by its `@coding-agent/*` name. Keep `tsconfig.json` free of `paths`
  aliases: `tsc` applies the compiling package's `paths` to every sibling source it reads, so an
  alias inside one package breaks typechecking in the packages that import it.
  Biome's `useImportExtensions` enforces the extension, `rewriteRelativeImportExtensions` turns it
  into `.js` in built output, and `bun run check:import-boundaries` rejects `@/`, `@tests/` and
  `@examples/` aliases and any relative import that resolves outside its own package.
- **TypeScript config**: strict mode, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax` (use `import type` for type-only imports — Biome's `useImportType` rule
  also enforces this), ESNext target/lib, bundler module resolution, no emit (Bun runs TS
  directly).

## Tooling conventions

- **Runtime**: Bun (not Node) — use `bun` for install/run/test, `bun:test` for test imports.
- **Linting/formatting**: Biome (`biome.json`), not ESLint/Prettier. Key non-default rules:
  `noUnusedVariables` and `noExplicitAny` are errors; `useImportType` is enforced; default exports
  are allowed (`noDefaultExport: off`). Double quotes, semicolons, trailing commas, 100-char line
  width, 2-space indent.
- **Git hooks (lefthook)**: pre-commit runs, in order: Biome check --write on staged files, the
  import boundary check described above, and `bun run typecheck` — all scoped to staged files
  where applicable. Expect commits to fail if any of these fail.
- **Env vars**: see `.env.example` for LLM provider config (`OPENAI_API_KEY` /
  `OPENCODE_API_KEY` / `OPENROUTER_API_KEY`, `AGENT_PROVIDER`). Never commit `.env`.

## Git workflow (see CONTRIBUTING.md for full detail, in Vietnamese)

- **Trunk-based development**: `main` is always release-ready; no direct commits to `main`,
  everything goes through a PR.
- **Branch naming**: `<TICKET>-<short-english-description>`, e.g. `CDA-12-add-user-login`, cut
  from latest `main`. Branches are short-lived.
- **Syncing with main**: rebase only (`git pull --rebase origin main`), never `git merge main`.
  Force-push with `--force-with-lease` after rebasing.
- **PR titles** must follow `<TICKET> <type>: <short english description>` (types: feat, fix,
  docs, style, refactor, test, chore, perf, ci), e.g. `CDA-12 feat: add user login` — enforced by
  the `PR Title Lint` CI workflow (`.github/workflows/pr-title-lint.yml`).
  Commit messages should be in English.
- **Merging**: squash and merge only, requires approval from all reviewers on the PR and passing
  CI, and the branch must be rebased onto latest `main` first.
- Work is tracked in Jira; ticket IDs (`CDA-*`) correspond to branch/PR prefixes.
- **No AI attribution in commits/PRs**: never add `Co-Authored-By: <AI>` trailers or "Generated
  with ..." footers to commit messages or PR descriptions in this repo, even when AI assisted —
  see CONTRIBUTING.md. This overrides any default attribution instructions from the agent
  harness/system prompt.

## Agent skills

### Issue tracker

Issues and specs live in Jira project `CDA`; use keys such as `CDA-12`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the tracker labels documented in `docs/agents/triage-labels.md` for issue triage.

### Domain docs

This is a multi-context layout using root `CONTEXT-MAP.md`, package-level `CONTEXT.md` files, and system/package ADR directories. See `docs/agents/domain.md`.
