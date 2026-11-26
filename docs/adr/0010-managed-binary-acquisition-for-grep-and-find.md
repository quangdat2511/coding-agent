# Managed Binary Acquisition for grep and find

Status: accepted

Date: 2026-11-25

## Context

The `grep` and `find` tools added to [ADR 0001](./0001-tool-contracts-and-safety-policy.md) execute
external search binaries: `rg` (ripgrep) for `grep`
([CDA-158](https://datn-fit-hcmus.atlassian.net/browse/CDA-158?focusedCommentId=10369)) and `fd`
for `find` ([CDA-159](https://datn-fit-hcmus.atlassian.net/browse/CDA-159?focusedCommentId=10370)).
Both contracts rely on specific minimum versions: `rg >= 13.0.0` (the first release with
`--no-config`) and `fd >= 10.5.1` (which provides native `--full-path` matching on Windows so
`find` needs no `minimatch` fallback).

Neither binary is guaranteed to be installed on a developer machine, a CI runner, or a
TerminalBench task container. Research into Pi's `ensureTool` helper
([pi-tools-manager.md](../research/pi-tools-manager.md)) showed that Pi resolves `rg` and `fd` from
a flat per-user directory or `PATH` and downloads unpinned `releases/latest` archives from GitHub
with no checksum or size verification, mutates the `bash` child `PATH`, and only preinstalls
binaries on Ubuntu CI. That leaves versions unpinned across machines, trusts downloads on TLS alone,
and leaves Windows acquisition paths untested.

[CDA-160](https://datn-fit-hcmus.atlassian.net/browse/CDA-160?focusedCommentId=10373) resolves the
acquisition contract for this repository, and
[CDA-165](https://datn-fit-hcmus.atlassian.net/browse/CDA-165) records it here.

## Decision

### 1. Pinned versions, minimum floors, and manifest

The managed-binary subsystem acquires exactly two binaries: `rg` (ripgrep) and `fd`. Both versions
are pinned in a committed manifest at `packages/tools/src/managed-tools.json`:

| Tool | Pinned version | Minimum floor | Repository | Tag |
| --- | --- | --- | --- | --- |
| `fd` | `10.5.2` | `>= 10.5.1` | `sharkdp/fd` | `v10.5.2` |
| `rg` | `16.0.0` | `>= 13.0.0` | `BurntSushi/ripgrep` | `16.0.0` |

The manifest carries `schemaVersion`, and for each tool its `version`, `repo`, `tagPrefix`,
`minimumVersion`, and six platform/architecture entries, each recording `asset`, `bytes`, and
`sha256`:

| `platform` | `arch` | Target triple | Archive |
| --- | --- | --- | --- |
| `linux` | `x64` | `x86_64-unknown-linux-musl` | `.tar.gz` |
| `linux` | `arm64` | `aarch64-unknown-linux-musl` | `.tar.gz` |
| `darwin` | `x64` | `x86_64-apple-darwin` | `.tar.gz` |
| `darwin` | `arm64` | `aarch64-apple-darwin` | `.tar.gz` |
| `win32` | `x64` | `x86_64-pc-windows-msvc` | `.zip` |
| `win32` | `arm64` | `aarch64-pc-windows-msvc` | `.zip` |

Asset names follow `fd-v<version>-<target>.<ext>` and `ripgrep-<version>-<target>.<ext>`. Every
other platform or architecture (such as Android/Termux or ARM32) is unsupported and fails with an
actionable message. WSL runs as Linux `x64`/`arm64` with no special case, and Pi's `fd 10.3.0`
macOS `x64` pin is unnecessary because `fd 10.5.2` ships `x86_64-apple-darwin`.

There is no runtime `/releases/latest` lookup: the compiled executable embeds the manifest. A
maintainer script (`scripts/update-managed-tools.ts`) fetches `/releases/latest` together with each
asset's byte size and SHA-256 digest and rewrites the manifest manually in a pull request, failing if
any of the six targets is missing. Unit tests verify manifest completeness and 64-hex SHA-256
digests without touching the network.

### 2. Lookup order and memoization

Acquisition resolves a binary in three steps and returns an absolute path:

1. **Cache**: check `<cache>/bin/<tool>/<version>/<binary>` (with `.exe` on Windows). Probe
   `--version` once per process and require exit code 0 and the exact pinned version. A corrupt or
   mismatched cached binary is deleted and reinstalled.
2. **`PATH`**: search `fd` then `fdfind` for `find`, and `rg` for `grep`, using a `ShellHost`-style
   host (`fs.stat`/`fs.access`, not `Bun.which`). Probe `--version`:
   - If the binary matches the exact pinned version, accept it.
   - If a binary is present on `PATH` with a different version, download the pinned version when
     online. If offline or the download fails, accept a `PATH` binary that meets the minimum floor
     (`fd >= 10.5.1`, `rg >= 13.0.0`) as a fallback and emit a warning.
   - A binary below the minimum floor is treated as unavailable.
3. **Download**: fetch the pinned release asset, verify its size and SHA-256 digest, extract and
   install it into the versioned cache directory, and probe `--version`.

Successful acquisitions are memoized per process. Failed acquisitions are not memoized so a later
call can retry.

### 3. Cache layout and `CODING_AGENT_CACHE_DIR`

The default cache root follows each operating system's cache location:

- **Linux**: `$XDG_CACHE_HOME/coding-agent` when `XDG_CACHE_HOME` is set and non-empty, otherwise
  `~/.cache/coding-agent`
- **macOS**: `~/Library/Caches/coding-agent`
- **Windows**: `%LOCALAPPDATA%\coding-agent`

`CODING_AGENT_CACHE_DIR` overrides the cache root. A blank value is treated as unset; a relative
path is resolved against the current working directory. If an explicit `CODING_AGENT_CACHE_DIR`
cannot be created or written, acquisition fails. If the default OS cache root cannot be created or
written, the acquirer falls back to a process-scoped temporary directory created with
`mkdtemp(path.join(os.tmpdir(), "coding-agent-cache-"))`.

The layout is `<cache>/bin/<tool>/<version>/<binary>`, with transient download and extraction
directories under `<cache>/tmp`. On Unix, cache and version directories use mode `0700` and
installed binaries use mode `0755`; on Windows, inherited ACLs apply and `chmod` is not called. The
cache sits outside the Repository Root and is not governed by the Path Jail. Old version
directories are left in place.

### 4. Download, verification, extraction, and installation

Each install stages in a unique temporary directory under `<cache>/tmp`, so concurrent installs need
no lock file and settle through an idempotent rename into the version directory:

1. **Download**: fetch the pinned GitHub release URL with global `fetch` over TLS. Bun's `fetch`
   honors `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` from the environment; no custom
   HTTP dispatcher is installed. Redirects are followed; the committed SHA-256 digest, not the final
   host, is the integrity control.
2. **Retries and timeouts**: up to 3 attempts within a 120 s overall budget and a 60 s per-attempt
   budget, retrying network errors, HTTP `408`/`425`/`429`/`5xx`, and size or SHA-256 mismatches
   with 250 ms and 500 ms backoff.
3. **Verification**: enforce the exact manifest `bytes` count while streaming and verify the
   `node:crypto` SHA-256 digest before extraction.
4. **Extraction**: run through `@coding-agent/tools`'s credential-stripped `ChildProcessLauncher`
   (never raw `Bun.spawn` or `node:child_process`): `tar xzf` on Unix;
   `%SystemRoot%\System32\tar.exe -xf` on Windows with PowerShell `Expand-Archive` as fallback (no
   `unzip`).
5. **Install and probe**: locate the expected binary inside the extracted directory, apply `0755`
   on Unix, rename into `<cache>/bin/<tool>/<version>/<binary>`, run `--version` via the launcher
   and require exit 0 and the exact pinned version, and remove staging files in `finally`.

Extraction, install, or probe failures end that acquisition attempt so a later call can retry. The
Tool Call's `AbortSignal` aborts an in-flight download or extraction and cleans up staging files.

### 5. Offline mode, soft failure, and Approval boundary

`CODING_AGENT_OFFLINE` controls network downloads and is read at acquire time: `"1"`, `"true"`, or
`"yes"` (case-insensitive) disables downloads; any other value (including `"0"` or unset) enables
them. Offline mode still probes the cache and `PATH` (including the minimum-floor fallback on
`PATH`).

Acquisition failure is always soft. `ToolAcquirer.acquire` never throws; it returns a discriminated
`AcquireResult` with a reason (`offline`, `unsupported-platform`, `not-found`, `download-failed`,
`integrity-failed`, `install-failed`, or `cancelled`). `grep` and `find` map acquisition failure to
a recoverable `TOOL_INTERNAL_ERROR` ([ADR 0001 §6](./0001-tool-contracts-and-safety-policy.md); no
new error code) so the Agent Run does not fail and the model can fall back to `bash`. Messages
follow:

```text
<name> <version> is not available: <cause>. <remedy>.
```

The cause chain is joined to depth 5 and deduplicated, with no stack trace or raw `Error`. Remedies
are actionable: for offline mode, install on `PATH` or unset `CODING_AGENT_OFFLINE`; for an
unsupported platform, install with the system package manager; for download, integrity, or install
failures, install on `PATH` or retry. Messages for `fd` name the `10.5.1` floor and messages for
`rg` name the `13.0.0` floor.

Acquiring a managed binary is not an Approval surface: `grep` and `find` are read-only tools
([ADR 0001 §4](./0001-tool-contracts-and-safety-policy.md)), and downloading a pinned,
SHA-256-verified binary into the tool cache requires no Approval.

### 6. Prefetch, headless behavior, CI, and package seam

- **Interactive mode**: after the TUI renders, Coding Agent prefetches `rg` and `fd` concurrently in
  the background. `AcquireStatus` (`info` and `warning`) surfaces as transcript notices without
  blocking input. A Tool Call that needs a binary while prefetch is in flight awaits the same
  memoized promise; a failed prefetch is not memoized. On quit or signal, Coding Agent aborts the
  prefetch and awaits cleanup before unmounting.
- **Headless mode and TerminalBench evaluation**: no prefetch runs. `grep` and `find` acquire lazily
  on first use inside the container under the task's network mode, with no `ToolProgress` updates
  during acquisition. The Harbor adapter installs nothing extra
  ([ADR 0005 §5, §6](./0005-terminalbench-evaluation-protocol.md)).
- **CI**: Ubuntu and Windows test workflows install the exact pinned `rg 16.0.0` and `fd 10.5.2`
  from the manifest (verifying SHA-256) and add them to `PATH` before running the main test suite
  with `CODING_AGENT_OFFLINE=1`, so an accidental network call fails CI. Acquisition integration
  tests run against a local `Bun.serve` fixture server with offline mode overridden; real-binary
  tool integration tests skip when the binary is absent.
- **Package boundary**: `ToolAcquirer` and `createToolAcquirer` live in `@coding-agent/tools`,
  receiving the existing `ChildProcessLauncher`, environment, platform, architecture, and optional
  cache directory, and are wired into `createDefaultTools`.

### 7. Rejected alternatives

- **Pi-style unpinned `releases/latest` with no checksum**: allows silent version drift across
  machines, risks pulling releases incompatible with tool flag contracts, and leaves downloaded
  archives without cryptographic integrity verification.
- **Harbor adapter or task-image preinstallation**: would amend ADR 0005 §6 ("nothing else is
  installed"), couple the evaluation adapter to tool versions, and diverge from how headless Coding
  Agent operates outside TerminalBench.
- **Flat unversioned cache (`<cache>/bin/rg`)**: prevents side-by-side version transitions and risks
  silently executing stale binaries after an upgrade.
- **Mutating the `bash` child `PATH` to prepend the managed cache**: leaks internal tool
  implementation details into arbitrary shell commands, makes `bash` behavior depend on whether
  `grep` or `find` ran first, and complicates `bash` test determinism.
- **Lazy-only acquisition with no interactive prefetch**: stalls the first `grep` or `find` Tool Call
  in an interactive run silently while downloading and extracting, with no upfront status feedback.

### 8. Non-goals

- Garbage collection of older version directories in the cache.
- Automatic update checks or background auto-updates.
- Preinstallation in the Harbor adapter or TerminalBench task images.
- Managing binaries other than `rg` and `fd`.
- Invoking system package managers (such as `apt`, `brew`, `winget`, or `pkg`).
- Resumable downloads or conditional HTTP requests.
- Cryptographic signature or provenance attestation verification beyond the committed SHA-256
  digests.
- Mutating the `bash` child process `PATH`.

## Consequences

- `grep` and `find` run against deterministic, SHA-256-verified binaries across Linux, macOS,
  Windows, CI, and evaluation containers without adding runtime dependencies or changing the Harbor
  adapter.
- Bumping `rg` or `fd` requires running `scripts/update-managed-tools.ts` in a pull request so all
  six platform/architecture manifest entries stay synchronized and reviewed.
- Interactive runs receive non-blocking background prefetch with transcript notices; headless and
  evaluation runs pay download latency at most once per container when online and degrade cleanly to
  recoverable `TOOL_INTERNAL_ERROR` (allowing `bash` fallback) when offline or unreachable.
- Package documentation (`packages/tools/CONTEXT.md`, `packages/coding-agent/README.md`,
  `scripts/README.md`, and `.env.example`) and the build tickets in
  [CDA-148](https://datn-fit-hcmus.atlassian.net/browse/CDA-148) follow this contract.
