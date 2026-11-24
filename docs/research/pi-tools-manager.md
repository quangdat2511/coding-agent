# CDA-152: Reproducing Pi's `ensureTool` acquisition of ripgrep and fd

Research for [CDA-152](https://datn-fit-hcmus.atlassian.net/browse/CDA-152), one question on the
[CDA-149](https://datn-fit-hcmus.atlassian.net/browse/CDA-149) planning map. It reports what Pi
does, not what this repository should do.

## Question

What would it take to reproduce Pi's `ensureTool` binary acquisition for `rg` and `fd` in this
repository? The scope is: lookup order and cache layout, version resolution and asset naming, the
platform/arch table, download and extraction with retries and timeouts, offline mode and status
messages, the security posture (checksums, redirects, proxy, user agent), Windows specifics, which
CI or evaluation images must preinstall the binaries, and how the resolved path reaches the
`grep`/`find` tools and their tests.

## Short answer

- **One module owns both tools.** `packages/coding-agent/src/utils/tools-manager.ts` resolves a
  tool in one of two places: a file in `<agentDir>/bin` (default `~/.pi/agent/bin`), or a command
  on `PATH` under the names `fd`/`fdfind` and `rg`. Only when both miss does it download.
- **Version comes from a redirect, not the API.** `GET https://github.com/<repo>/releases/latest`
  with `redirect: "manual"`; the tag is the last path segment of `Location`, with a leading `v`
  stripped. Pi explains that the API's 60-requests-per-hour anonymous quota is exhausted behind
  shared egress IPs, while the web redirect is not.
- **Assets are `<name>-<version>-<target>`.** `fd-v<version>-…` from `sharkdp/fd` and
  `ripgrep-<version>-…` from `BurntSushi/ripgrep`; darwin `.tar.gz`, Linux `unknown-linux-musl`
  `.tar.gz`, Windows `pc-windows-msvc` `.zip`. Only `x64` and `arm64` are mapped.
- **Downloads are unverified.** HTTPS, a 120 s budget shared by up to three immediate attempts, and
  no checksum, signature, size cap or content-length check. ripgrep publishes a `.sha256` per
  asset and fd does not; Pi fetches neither.
- **Two hard-coded exceptions.** `fd` is pinned to `10.3.0` on darwin/x64 because fd 10.4.2
  dropped `x86_64-apple-darwin`, and Android/Termux is answered with `pkg install fd`/`pkg install
  ripgrep` instead of a download.
- **Failure is soft.** `ensureTool` returns `undefined` after a `warning` status that joins the
  error cause chain (depth 5); the `grep` and `find` tools then reject with a fixed message.
- **Extraction shells out.** `tar xzf` on Unix, and on Windows `%SystemRoot%\System32\tar.exe`
  (bsdtar) with a PowerShell `Expand-Archive` fallback; `unzip` then `tar` on Unix for zips.
  The binary is `chmod 0755` on Unix, `rename`d into place, and the archive and temp directory
  are removed in a `finally`.
- **Pi's coding-agent CI preinstalls on Ubuntu only.** `ci.yml`'s test jobs are all
  `ubuntu-latest` and `apt-get install` `fd-find ripgrep` with a `fdfind → fd` symlink. Pi's
  Windows runners belong to `packages/env` tests and release-binary smoke tests, so the `.exe`,
  zip and `System32\tar.exe` branches have no test job. This repository's CI does test Windows and
  installs neither tool.

## Research basis

Pi snapshot: **`8209929fb553e7a8c91dc0894569f9ec43dd201f`**, the `main` commit
[`fix(coding-agent): correct the fallbacks for unsaved bash output files (#12461)`](https://github.com/earendil-works/pi/commit/8209929fb553e7a8c91dc0894569f9ec43dd201f),
dated 2026-11-24 00:55 +0100. `packages/coding-agent/package.json` reports version `1.6.0`
([package.json L3](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/package.json#L3)).
The repository was cloned at that commit and the files below were read locally, so line numbers
are from that tree.

This repository was read at `adb7a73` on branch `CDA-152-pi-tools-manager`; all repository
citations are paths in that tree. Release-asset facts (names, tag prefixes, which targets exist,
the `.sha256` files) were read on **2026-11-24** from the GitHub Releases API for `sharkdp/fd` and
`BurntSushi/ripgrep`, and the four archive layouts were confirmed by downloading and listing them.

Files read in full: `tools-manager.ts` (397 lines), `management-http.ts`, `pi-user-agent.ts`,
`config.ts` (the `getAgentDir`/`getBinDir` region), `grep.ts` and `find.ts` (the `ensureTool` and
`spawn` regions), `interactive-mode.ts` (prefetch and status), `shell.ts` (`getShellEnv`),
`migrations.ts` (tools→bin migration), `tools-manager.test.ts`, `find-abort-before-spawn.test.ts`,
`http-dispatcher.ts`, and the `identity.ts` `formatUserAgent` function.

## Findings

### 1. Entry point and call sites

`ensureTool(tool, onStatus?)` returns `string | undefined` and reports progress only through its
callback, never the console: the doc comment says "Reports progress through `onStatus`; status
messages are otherwise silent" ([packages/coding-agent/src/utils/tools-manager.ts 332-397](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L332-L397)).
The status type is `{ type: "info" | "warning"; message: string }`
([packages/coding-agent/src/utils/tools-manager.ts 327-330](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L327-L330)).

There are four call sites:

| Site | What it does | Citation |
| --- | --- | --- |
| Interactive startup | `Promise.all([ensureTool("fd", …), ensureTool("rg", …)])` after the TUI mounts, "so slow downloads do not make startup appear frozen"; both run concurrently and only the `fd` result is kept, for autocomplete | [packages/coding-agent/src/modes/interactive/interactive-mode.ts 1182-1189](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1182-L1189) |
| `grep` tool | `ensureTool("rg")` inside `execute`, before `spawn` | [packages/coding-agent/src/core/tools/grep.ts 131-135](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L131-L135) |
| `find` tool | `ensureTool("fd")` inside `execute`, before `spawn` | [packages/coding-agent/src/core/tools/find.ts 176-185](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L176-L185) |
| TUI autocomplete | Receives the resolved `fdPath` through the interactive mode | [packages/coding-agent/src/modes/interactive/interactive-mode.ts 902](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L902) |

Print/RPC modes have no prefetch: the first `grep` or `find` call performs the download, and the
`bash` tool only sees a managed binary after the interactive prefetch has put it on the child
`PATH` (§9).

### 2. Lookup order and cache directory

The lookup is local file first, then `PATH`:

1. `join(TOOLS_DIR, binaryName + (platform === "win32" ? ".exe" : ""))`; if `existsSync` is true,
   that absolute path is returned ([packages/coding-agent/src/utils/tools-manager.ts 71-80](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L71-L80)).
2. Otherwise each alternative name is tried with `spawnSync(cmd, ["--version"], { stdio: "pipe" })`;
   a hit returns the **bare command name**, not a path, so the caller's `spawn` resolves `PATH`
   again at exec time ([packages/coding-agent/src/utils/tools-manager.ts 82-91](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L82-L91),
   [packages/coding-agent/src/utils/tools-manager.ts 60-69](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L60-L69)).
3. Nothing at all returns `null`, and `ensureTool` continues to the download decision.

The alternative names are `["fd", "fdfind"]` for fd and none for rg, which therefore falls back to
`["rg"]` ([packages/coding-agent/src/utils/tools-manager.ts 42-58](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L42-L58),
[packages/coding-agent/src/utils/tools-manager.ts 83](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L83)). `fdfind` is Debian's binary name.
Note that the local-file check has no executable test and no `--version` probe: a truncated or
wrong-architecture file in the cache directory is returned and fails on every later spawn.

The cache directory is `getBinDir()`, computed once at module load as
`join(getAgentDir(), "bin")` ([packages/coding-agent/src/utils/tools-manager.ts 11](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L11),
[packages/coding-agent/src/config.ts 663-666](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/config.ts#L663-L666)). `getAgentDir()` is
`process.env[PI_CODING_AGENT_DIR]` (tilde-expanded) or `join(homedir(), CONFIG_DIR_NAME, "agent")`,
where `CONFIG_DIR_NAME` is `.pi` from the package's `piConfig.configDir`
([packages/coding-agent/src/config.ts 629-636](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/config.ts#L629-L636),
[packages/coding-agent/src/config.ts 606](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/config.ts#L606),
[packages/coding-agent/package.json 6-8](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/package.json#L6-L8)). The default is therefore `~/.pi/agent/bin`.

Layout and permissions:

- The directory is created with `mkdirSync(TOOLS_DIR, { recursive: true })` and no `mode`, so it
  gets the process umask (typically `0755`) ([packages/coding-agent/src/utils/tools-manager.ts 263-264](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L263-L264)).
  Pi does set `0700`/`0600` where it stores secrets (for example
  [packages/coding-agent/src/core/auth-storage.ts 37](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/auth-storage.ts#L37),
  [packages/coding-agent/src/core/auth-storage.ts 71](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/auth-storage.ts#L71)), but not here.
- The archive is written **into the same directory** under its release asset name, e.g.
  `~/.pi/agent/bin/ripgrep-16.0.0-x86_64-unknown-linux-musl.tar.gz`
  ([packages/coding-agent/src/utils/tools-manager.ts 266-272](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L266-L272)).
- After extraction only `fd`/`rg` (plus `.exe` on Windows) remain, under fixed names. There is no
  version marker, no metadata file and no update check: a binary, once present, is used forever
  ([packages/coding-agent/src/utils/tools-manager.ts 77-80](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L77-L80)).
- A `migrations.ts` step moves `fd`/`rg`/`fd.exe`/`rg.exe` from the old `<agentDir>/tools` into
  `<agentDir>/bin`, deleting the source when the target exists
  ([packages/coding-agent/src/migrations.ts 174-209](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/migrations.ts#L174-L209)).

### 3. Version resolution

`getLatestVersion(repo)` ([packages/coding-agent/src/utils/tools-manager.ts 93-127](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L93-L127)):

- `GET https://github.com/${repo}/releases/latest` with `redirect: "manual"` and
  `User-Agent: getPiUserAgent(VERSION)`, inside `fetchWithRetry(…, { timeoutMs: 10_000 })`.
- Only status and headers are used; `response.body?.cancel()` is awaited in a `try` so the
  connection can be reused.
- A non-3xx answer throws
  `Failed to resolve latest <repo> release: HTTP <status> without redirect`.
- The tag is parsed from `new URL(location, "https://github.com").pathname.split("/").pop()`;
  the redirect must contain `/releases/tag/` or the call throws
  `Failed to resolve latest <repo> release: unexpected redirect to <location>`.
- The tag is `decodeURIComponent`-ed and a leading `v` is stripped, so `v10.5.2` becomes
  `10.5.2` and `16.0.0` is unchanged.

The redirect replaced an `api.github.com` call because "the anonymous API quota (60 requests/hour
per IP) is permanently exhausted behind shared egress IPs", according to the commit that introduced
it ([57e53b0d](https://github.com/earendil-works/pi/commit/57e53b0d790a5d81fde91542d867bdeba00adada),
CHANGELOG line 1096 in [packages/coding-agent/CHANGELOG.md 1096](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/CHANGELOG.md#L1096)). The same commit made
the fd pin below skip the lookup entirely.

The one hard-coded version: for `fd` on `darwin`/`x64`, the version is `"10.3.0"` and no request is
made ([packages/coding-agent/src/utils/tools-manager.ts 258-260](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L258-L260)). The reason is fd v10.4.2
permanently dropping `x86_64-apple-darwin`; the last release with that target was v10.3.0
([Pi issue #4559](https://github.com/earendil-works/pi/issues/4559), closed by
[7afd80d7](https://github.com/earendil-works/pi/commit/7afd80d78801cdd5a9be8c0e018d556605d90784)). The
pin is not revisited: as of 2026-11-24, fd v10.5.0 restored `x86_64-apple-darwin` and v10.5.2 ships
it again, yet Intel macOS still receives 10.3.0. No other tool or platform is pinned, and nothing
records which version a cached binary is.

The redirect's host is not validated, only its path: a redirect to another host whose path ends
in `/releases/tag/<tag>` would be accepted, though the download URL is still built on
`github.com/<repo>` (§4).

### 4. Asset naming and platform/arch mapping

`getReleaseTarget` maps Node's `platform()`/`arch()` to the Rust target triple that fd and ripgrep
share, and returns `undefined` for everything else
([packages/coding-agent/src/utils/tools-manager.ts 30-40](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L30-L40)):

| `platform()` | `arch()` | Target suffix | Archive |
| --- | --- | --- | --- |
| `darwin` | `arm64` | `aarch64-apple-darwin` | `.tar.gz` |
| `darwin` | `x64` | `x86_64-apple-darwin` | `.tar.gz` |
| `linux` | `arm64` | `aarch64-unknown-linux-musl` | `.tar.gz` |
| `linux` | `x64` | `x86_64-unknown-linux-musl` | `.tar.gz` |
| `win32` | `arm64` | `aarch64-pc-windows-msvc` | `.zip` |
| `win32` | `x64` | `x86_64-pc-windows-msvc` | `.zip` |

Any other architecture returns `undefined`; the comment cites the regression where ARM32 fell back
to x86-64 binaries (#11209), fixed by
[c8ec752c](https://github.com/earendil-works/pi/commit/c8ec752cf92a612c340249f1d0abd1bdecaf5b9f).
Linux is **always musl**, statically linked, never gnu
([packages/coding-agent/src/utils/tools-manager.ts 36-38](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L36-L38),
CHANGELOG 1076 in [packages/coding-agent/CHANGELOG.md 1076](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/CHANGELOG.md#L1076)).

Asset names and download URLs
([packages/coding-agent/src/utils/tools-manager.ts 42-58](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L42-L58),
[packages/coding-agent/src/utils/tools-manager.ts 261-266](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L261-L266)):

| Tool | Repo | Tag prefix | Asset | URL |
| --- | --- | --- | --- | --- |
| fd | `sharkdp/fd` | `v` | `fd-v<version>-<target>` | `https://github.com/sharkdp/fd/releases/download/v<version>/<asset>` |
| rg | `BurntSushi/ripgrep` | `` (none) | `ripgrep-<version>-<target>` | `https://github.com/BurntSushi/ripgrep/releases/download/<version>/<asset>` |

Checked against the live releases on 2026-11-24: fd's latest is `v10.5.2` with
`fd-v10.5.2-x86_64-unknown-linux-musl.tar.gz`, `fd-v10.5.2-aarch64-apple-darwin.tar.gz` and
`fd-v10.5.2-x86_64-pc-windows-msvc.zip`; ripgrep's latest is `16.0.0` with
`ripgrep-16.0.0-aarch64-unknown-linux-musl.tar.gz`,
`ripgrep-16.0.0-x86_64-apple-darwin.tar.gz` and
`ripgrep-16.0.0-x86_64-pc-windows-msvc.zip`
([fd releases](https://github.com/sharkdp/fd/releases), [ripgrep releases](https://github.com/BurntSushi/ripgrep/releases)).
All four archives put the binary one directory deep, named exactly like the asset without its
extension — `fd-v10.5.2-x86_64-unknown-linux-musl/fd`,
`ripgrep-16.0.0-x86_64-pc-windows-msvc/rg.exe` — which is the first candidate `downloadTool`
checks ([packages/coding-agent/src/utils/tools-manager.ts 291-300](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L291-L300)).

Because the version is "latest" at first download and never refreshed, two machines can hold
different fd/rg versions indefinitely; the file name is the only thing that is stable. Pi's find
tool carries version-dependent workarounds (fd before 10.5.1 on Windows), noting "fd 10.5.1, which
pi now downloads" (CHANGELOG line 182 in [packages/coding-agent/CHANGELOG.md 182](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/CHANGELOG.md#L182)).

### 5. Download, extraction, installation

`downloadTool` is the whole installer
([packages/coding-agent/src/utils/tools-manager.ts 246-319](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L246-L319)):

1. Recompute `target`; if `undefined`, throw `Unsupported platform: <plat>/<arch>` (unreachable
   through `ensureTool`, which warns first).
2. Resolve the version (§3), build `assetName`, `mkdirSync(TOOLS_DIR)`, compute `archivePath` and
   `binaryPath`.
3. `downloadFile(url, archivePath)`: `fetchWithRetry(url, undefined, { timeoutMs: 120_000 })`; a
   non-OK response throws `Download failed with HTTP <status>: <url>`; a missing body throws
   `No response body`; the body is piped with
   `pipeline(Readable.fromWeb(response.body), createWriteStream(dest))`
   ([packages/coding-agent/src/utils/tools-manager.ts 129-143](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L129-L143)).
4. Create `extract_tmp_<binary>_<pid>_<Date.now()>_<8 random base36 chars>` inside `TOOLS_DIR`
   because "fd and rg downloads can run concurrently during startup"
   ([packages/coding-agent/src/utils/tools-manager.ts 274-280](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L274-L280)).
5. Extract by extension
   ([packages/coding-agent/src/utils/tools-manager.ts 282-289](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L282-L289)):
   - `.tar.gz` → `tar xzf <archive> -C <dir>`
     ([packages/coding-agent/src/utils/tools-manager.ts 190-195](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L190-L195)).
   - `.zip` on Windows → `%SystemRoot%\System32\tar.exe xf <archive> -C <dir>`, then a
     `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` call whose
     script block runs `Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force`
     with `$ErrorActionPreference = "Stop"`
     ([packages/coding-agent/src/utils/tools-manager.ts 197-244](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L197-L244)).
   - `.zip` elsewhere → `unzip -q <archive> -d <dir>`, then `tar xf <archive> -C <dir>`.
   - Anything else → `Unsupported archive format: <assetName>`.
   Failures include the command's error/message, stderr, stdout or exit status
   ([packages/coding-agent/src/utils/tools-manager.ts 167-188](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L167-L188)).
6. Find the binary: `<extractDir>/<assetName minus extension>/<binary>`, then
   `<extractDir>/<binary>`, then a depth-first walk for a file with that exact name; failure throws
   `Binary not found in archive: expected <binary> under <extractDir>`
   ([packages/coding-agent/src/utils/tools-manager.ts 291-306](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L291-L306),
   [packages/coding-agent/src/utils/tools-manager.ts 145-165](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L145-L165)).
7. `renameSync(extractedBinary, binaryPath)` and, on non-Windows, `chmodSync(binaryPath, 0o755)`
   ([packages/coding-agent/src/utils/tools-manager.ts 302-311](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L302-L311)).
8. `finally`: `rmSync(archivePath, { force: true })` and
   `rmSync(extractDir, { recursive: true, force: true })`
   ([packages/coding-agent/src/utils/tools-manager.ts 312-316](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L312-L316)).

Edge cases visible in the code:

- A failed **download** happens before the `try`, so a partial archive stays in `bin/` until the
  next successful install overwrites it; a failed **extraction** is cleaned up.
- The archive path is not unique per process, so two Pi processes downloading the same tool share
  it while their extract directories do not. There is no lock and no `.part` name.
- `renameSync` targets `binaryPath` without unlinking it first. POSIX `rename` replaces
  atomically; on Windows Pi neither removes the destination nor checks anything beyond
  `renameSync` not throwing.
- There is no verification that the renamed binary runs, no size limit, and no check that the
  extracted file is executable before `chmod`.
- The archive is extracted with a general-purpose tool and no traversal guard, so the installer
  trusts the archive completely.

### 6. Retries, timeouts, offline mode, status and failure messages

`fetchWithRetry` is a shared transport helper
([packages/coding-agent/src/utils/management-http.ts 27-78](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/management-http.ts#L27-L78)):

- `maxRetries` defaults to `2`, i.e. three attempts.
- Retryable statuses: `408, 425, 429, 500, 502, 503, 504`
  ([packages/coding-agent/src/utils/management-http.ts 3](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/management-http.ts#L3)).
- Retries are immediate — no backoff, no jitter, no `Retry-After` handling.
- `timeoutMs` is one `AbortSignal.timeout` created **before** the loop, so it is an overall budget
  shared by every attempt; `attemptTimeoutMs` would be per-attempt, and `tools-manager` does not use
  it. A hung connection can therefore consume the full budget
  ([packages/coding-agent/src/utils/management-http.ts 38-50](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/management-http.ts#L38-L50)).
- Caller cancellation and the overall timeout are terminal; transport failures and transient statuses
  are retried.

Constants: `NETWORK_TIMEOUT_MS = 10_000` for version resolution and
`DOWNLOAD_TIMEOUT_MS = 120_000` for the archive
([packages/coding-agent/src/utils/tools-manager.ts 12-13](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L12-L13)). The 120 s value replaced 10 s
after a first-run crash, in
[5c9ce47c](https://github.com/earendil-works/pi/commit/5c9ce47c53e0a60f7450add52f30b58915beb960)
(CHANGELOG line 3646 in [packages/coding-agent/CHANGELOG.md 3646](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/CHANGELOG.md#L3646)).

Offline mode is read from `PI_OFFLINE`: unset or empty is online; `"1"`, `"true"` and `"yes"`
(case-insensitive) are offline; any other value, such as `"0"`, is online
([packages/coding-agent/src/utils/tools-manager.ts 15-19](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L15-L19)). The `--offline` flag sets
`PI_OFFLINE=1` and `PI_SKIP_VERSION_CHECK=1` at startup
([packages/coding-agent/src/main.ts 610-614](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/main.ts#L610-L614); documented in
[packages/coding-agent/docs/cli.md 243-244](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/cli.md#L243-L244) and
[packages/coding-agent/docs/environment-variables.md 84](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/environment-variables.md#L84)).

The exact status strings, in the order `ensureTool` can emit them
([packages/coding-agent/src/utils/tools-manager.ts 337-397](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L337-L397)):

| Condition | Type | Message |
| --- | --- | --- |
| offline, not found | warning | `<name> not found. Offline mode enabled, skipping download.` |
| `platform() === "android"` | warning | `<name> not found. Install with: pkg install <package>` |
| target unmapped | warning | `<name> not found. Automatic download is not supported on <plat>/<arch>. Install <name> with your system package manager.` |
| about to download | info | `<name> not found. Downloading...` |
| success | info | `<name> installed to <path>` |
| download threw | warning | `Failed to download <name>: <cause chain joined by ": ">` |

`<name>` is the tool's `name` field, so `rg` reports as `ripgrep`. The Termux packages are
`fd` and `ripgrep` ([packages/coding-agent/src/utils/tools-manager.ts 321-325](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L321-L325)); the
`fd` name was corrected from `fd-find` in
[7ddb7c67](https://github.com/earendil-works/pi/commit/7ddb7c67a86d291518782d50049a366975edf8e7).
Android is checked **before** the target map, so Termux gets the `pkg install` hint rather than the
"unsupported platform" one.

The failure path walks `error.cause` up to five levels, deduplicating identical messages, and joins
them with `": "`; the comment explains that a fetch failure is a bare `"fetch failed"` whose
actionable detail (DNS, TLS, timeout) sits in the cause
([packages/coding-agent/src/utils/tools-manager.ts 378-395](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L378-L395)). A test asserts exactly
`Failed to download fd: fetch failed: connect ETIMEDOUT 140.82.113.3:443`
([packages/coding-agent/test/tools-manager.test.ts 133-154](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools-manager.test.ts#L133-L154)).

Failure never throws to the caller: `ensureTool` returns `undefined`. The tools then reject with
fixed messages — `ripgrep (rg) is not available and could not be downloaded`
([packages/coding-agent/src/core/tools/grep.ts 132-135](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L132-L135)) and
`fd is not available and could not be downloaded`
([packages/coding-agent/src/core/tools/find.ts 182-185](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L182-L185)). Interactive mode prints the
warning into the chat instead (`Warning: ` prefix, warning colour) through
`showManagedToolStatus` ([packages/coding-agent/src/modes/interactive/interactive-mode.ts 4012-4023](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L4012-L4023)).

### 7. Security: integrity, redirects, proxy, user agent

- **No integrity verification.** `tools-manager.ts` contains no `sha256`, `checksum` or
  `signature` reference (the strings do not appear in the file). ripgrep's releases publish a
  `<asset>.sha256` beside every archive — the 16.0.0 listing includes
  `ripgrep-16.0.0-x86_64-pc-windows-msvc.zip.sha256` — and fd's releases publish none. Pi fetches
  neither, so integrity rests on TLS and GitHub's storage.
- **Redirects.** The version request uses `redirect: "manual"` and reads `Location` itself; the
  archive download uses default redirect handling, so it follows GitHub's redirect to its asset
  host. Neither checks the final host of the download.
- **No size or type checks.** No `Content-Length` comparison, no maximum size, no archive member
  validation; the extraction tool's own behaviour defines what lands on disk.
- **Proxy.** `ensureTool` passes no dispatcher or agent. Pi instead installs a process-wide undici
  dispatcher, `new undici.EnvHttpProxyAgent({…})`, via `undici.setGlobalDispatcher`
  ([packages/coding-agent/src/core/http-dispatcher.ts 81-112](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/http-dispatcher.ts#L81-L112)), and the `httpProxy` setting
  is copied into `HTTP_PROXY`/`HTTPS_PROXY` only when those are unset
  ([packages/coding-agent/src/core/http-dispatcher.ts 45-50](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/http-dispatcher.ts#L45-L50)). Downloads inherit that
  policy because they use the global `fetch`. `NO_PROXY` handling comes from
  `EnvHttpProxyAgent`, not from `tools-manager`.
- **User agent.** Only the version request sets one:
  `pi/<version> (<platform>; bun/<v>|node/<v>; <arch>)`
  ([packages/coding-agent/src/utils/pi-user-agent.ts 1-6](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/pi-user-agent.ts#L1-L6);
  [packages/ai/src/utils/identity.ts 66-82](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/ai/src/utils/identity.ts#L66-L82)). `downloadFile` passes no headers, so the
  archive request carries whatever the runtime's fetch sends by default — no `pi` identity and no
  authentication, so any GitHub-side limit applies per IP.
- **No resume, no conditional request, no caching headers.** A dropped download restarts from zero
  on the next attempt or launch.

### 8. Windows specifics

- Local lookup and final file name add `.exe`
  ([packages/coding-agent/src/utils/tools-manager.ts 77](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L77),
  [packages/coding-agent/src/utils/tools-manager.ts 268-269](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L268-L269)); the `PATH` probe uses the
  bare names.
- Windows assets are `pc-windows-msvc` `.zip` (arm64 and x64) (§4).
- Extraction prefers `%SystemRoot%\System32\tar.exe` because Windows ships bsdtar, "which supports
  zip files. Prefer the System32 binary over Git Bash's GNU tar, which does not handle zip
  archives"; if that fails it falls back to PowerShell `Expand-Archive … -Force`
  ([packages/coding-agent/src/utils/tools-manager.ts 197-232](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L197-L232)). This replaced `unzip`,
  which Windows does not ship
  ([82caf064](https://github.com/earendil-works/pi/commit/82caf064e0eed2a848ede1f51f16a6f96483034b)).
- No `chmod` runs on Windows ([packages/coding-agent/src/utils/tools-manager.ts 308-311](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts#L308-L311)).
- The tools→bin migration handles `fd.exe`/`rg.exe`
  ([packages/coding-agent/src/migrations.ts 184](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/migrations.ts#L184)).
- **No coding-agent test job covers these branches.** `ci.yml`'s test matrix is
  `ubuntu-latest` only
  ([.github/workflows/ci.yml 64-67](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/.github/workflows/ci.yml#L64-L67)). Pi does run Windows elsewhere:
  `packages/env` tests use a `windows-latest`/`windows-11-arm` matrix
  ([.github/workflows/env.yml 128-133](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/.github/workflows/env.yml#L128-L133)), and
  `build-binaries.yml` smoke-tests release binaries on `windows-latest`
  ([.github/workflows/build-binaries.yml 135-146](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/.github/workflows/build-binaries.yml#L135-L146)).
  Neither runs `tools-manager.ts`, so the Windows acquisition path — `.exe` naming, zip extraction,
  System32 tar, PowerShell fallback — reaches users without an automated run.
- Pi's find tool additionally has Windows-specific fd-version workarounds, which is why the managed
  fd version matters beyond acquisition (CHANGELOG line 182,
  [packages/coding-agent/src/core/tools/find.ts 205-249](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L205-L249)).

### 9. How the resolved path reaches `grep` and `find`

Both tools call `ensureTool` inside `execute` and spawn the returned string directly; there is no
shim, no wrapper directory and no environment mutation at the tool boundary:

- `grep`: `const rgPath = await ensureTool("rg")`; `undefined` rejects; then
  `spawn(rgPath, ["--no-config", "--json", …], { cwd, stdio: ["ignore", "pipe", "pipe"] })`
  ([packages/coding-agent/src/core/tools/grep.ts 131-135](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L131-L135),
  [packages/coding-agent/src/core/tools/grep.ts 161-178](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts#L161-L178)).
- `find`: `const fdPath = await ensureTool("fd")`; `undefined` rejects; then
  `spawn(fdPath, args, …)` ([packages/coding-agent/src/core/tools/find.ts 176-185](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L176-L185),
  [packages/coding-agent/src/core/tools/find.ts 254](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts#L254)).

Separately, the managed directory is prepended to `PATH` for child processes by
`getShellEnv()`, so a `bash` command can use `rg` after the interactive prefetch
([packages/coding-agent/src/utils/shell.ts 171-183](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/shell.ts#L171-L183); rationale in the comment at
[packages/coding-agent/src/modes/interactive/interactive-mode.ts 1182-1184](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L1182-L1184)).

This matters for lookup order: the cache directory is checked before `PATH`, so a user's newer
`rg` on `PATH` loses to a stale managed copy, and `--version` is never compared.

### 10. How Pi tests it

There are three distinct approaches, none of which performs a real download:

1. **Unit tests mock the world.** `tools-manager.test.ts` mocks `fs` so `existsSync` is always
   false, `os` so `platform()` is `"linux"` and `arch()` is `"x64"`, `child_process` so
   `spawnSync` returns `{ error: new Error("not found") }`, and stubs the global `fetch`
   ([packages/coding-agent/test/tools-manager.test.ts 10-33](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools-manager.test.ts#L10-L33)). Tests cover the redirect
   forms (absolute, relative, body discarded, no redirect, wrong redirect) and the `ensureTool`
   messages for offline, cause-chain and unsupported-arch
   ([packages/coding-agent/test/tools-manager.test.ts 43-174](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools-manager.test.ts#L43-L174)). `PI_OFFLINE` is saved and
   restored in `afterEach` ([packages/coding-agent/test/tools-manager.test.ts 35-41](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools-manager.test.ts#L35-L41)).
   No test reaches `downloadTool`, so extraction, `chmod` and cleanup are untested.
2. **One tool test replaces the module.** `find-abort-before-spawn.test.ts` does
   `vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: async () => "fd" }))` to test that
   an abort during the `.git` lookup never starts fd
   ([packages/coding-agent/test/find-abort-before-spawn.test.ts 15-17](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/find-abort-before-spawn.test.ts#L15-L17)).
3. **Integration tests use real binaries installed by CI.** `ci.yml` installs `fd-find ripgrep`
   and symlinks `fdfind` to `fd` for the coding-agent and tui suites
   ([.github/workflows/ci.yml 86-92](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/.github/workflows/ci.yml#L86-L92)). The TUI autocomplete test resolves fd with
   `which fd`/`where fd` and skips when absent
   ([packages/tui/test/autocomplete.test.ts 12-48](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/tui/test/autocomplete.test.ts#L12-L48)).

So Pi verifies the decision logic and the message text with fakes, and trusts system binaries for
tool behaviour. The download path itself has no end-to-end test.

### 11. What this repository has today

| Concern | Pi | This repository at `adb7a73` |
| --- | --- | --- |
| Acquisition module | `utils/tools-manager.ts` | Does not exist; there is no `packages/coding-agent/src/utils` directory |
| Search tools | `grep`, `find`, `ls` alongside `read/bash/edit/write` | Registry holds only `read`, `write`, `edit`, `bash` (`packages/tools/src/registry.ts:11-22`) |
| Tool contract | Lives in the tool definitions under `core/tools/`; no ADR table | ADR 0001 lists only `read`/`write`/`edit`/`bash` (`docs/adr/0001-tool-contracts-and-safety-policy.md:28-31`); `grep`/`find` would need entries and error codes first |
| Per-user cache dir | `~/.pi/agent/bin`, overridable by `PI_CODING_AGENT_DIR` | No per-user config directory exists; `run-config.ts` resolves the repository root and output directory, not a cache |
| `PATH` handling | Managed dir prepended for bash children | `Bun.spawn` gets `{ ...process.env }` minus credentials, plus `CI=1`, `TERM=dumb`; no directory is added (`packages/tools/src/child-process.ts:30-45`) |
| Shell lookup | `getShellEnv()` prepends the bin dir | `findShell` searches `PATH` but mutates nothing (`packages/tools/src/shell.ts:27-68`) |
| HTTP policy | Global undici proxy dispatcher; retries helper | Providers call `globalThis.fetch` directly; no dispatcher or retry helper for downloads |
| User agent | `pi/<version> (<platform>; bun or node/<v>; <arch>)` | `coding-agent/<version>` is set per request in `packages/coding-agent/src/model-port.ts:28`; no shared helper |
| Bun/Node | Node 22 in CI, `undici` dependency | Bun 1.3.14 (`.bun-version:1`) |
| Windows CI | No coding-agent test job (`ci.yml` is Ubuntu-only; Windows covers `packages/env` and release smoke tests) | `Test (windows-2025)` runs `bun run test` with only Bun installed (`.github/workflows/ci.yml:69-95`) |
| Linux CI | Ubuntu, with `fd-find` and `ripgrep` preinstalled | Ubuntu 24.04, nothing installed (`.github/workflows/ci.yml:69-95`) |
| macOS CI | No macOS job for the coding-agent suite | `macos-26`, only on pushes to `main` (`.github/workflows/ci.yml:102-124`) |
| Evaluation images | Pi's container example installs `ripgrep` only (`containerization.md:42`) | Each trial runs in the task's own glibc image (`docs/adr/0005-terminalbench-evaluation-protocol.md:48-49`, `:311-314`); nothing installs `rg` or `fd` |

The compiled evaluation binary is built for `bun-linux-x64-baseline`/`bun-linux-arm64` and runs
inside the task container (`docs/adr/0005-terminalbench-evaluation-protocol.md:301-314`,
`:404-410`), so a Pi-style downloader would be the only source of `rg`/`fd` in a trial unless the
adapter or the task image provides them.

## Open questions for this repo

1. **Where does the cache live?** There is no per-user directory yet. Pi's answer is
   `<user config>/bin` with an env override; this repository would have to introduce that concept
   (or use a platform cache directory), decide its permissions, and decide whether it is shared
   between interactive runs and evaluation containers.
2. **Is network access at tool time acceptable?** ADR 0001 governs Safety and Approval; a download
   performed on the first `grep` is an unapproved network call inside `execute`. Pi does it with no
   prompt. Does this repository want that, a one-time setup step, or preinstalled binaries only?
3. **Pin or track latest?** Pi's "latest at first download, never updated" produces stale, silently
   different versions across machines, and its one pin exists because upstream dropped a target.
   Should this repository record versions in a lockfile, pin per platform, or check for updates?
4. **Do we need integrity checks?** ripgrep publishes `.sha256` per asset; fd publishes none. A
   checksum requirement therefore means either a maintained manifest (versions + hashes per
   platform) or vendored binaries.
5. **Concurrency.** Should two sessions downloading at once share one lock and one archive path, or
   is Pi's per-process temp directory plus shared archive path acceptable?
6. **Windows CI.** Pi's coding-agent suite does not run on Windows. This repository does; will
   it preinstall `rg`/`fd` (Chocolatey/Scoop) for tests, or let them download, and does the download
   then run through `System32\tar.exe` or a Bun API?
7. **Bun behaviour.** `redirect: "manual"`, `AbortSignal.timeout`/`any`, `Readable.fromWeb` and
   proxy environment handling are all inherited from Pi's Node/undici stack. Which of them does Bun
   1.3.14 support identically, and who owns an HTTP dispatcher if this repository adds one?
8. **Failure contract.** `ensureTool`'s `undefined` plus fixed tool messages has no error code.
   ADR 0001's tools carry codes such as `TOOL_INTERNAL_ERROR`; what should `grep`/`find` return
   when the binary is missing?
9. **`PATH` or explicit path?** Pi uses the absolute path for the tools and also prepends the
   directory to the bash child's `PATH`. Does this repository want both, and does prepending change
   what `bash` tests expect?
10. **Scope.** Is `fdfind` aliasing, Termux, and arm32 refusal in scope, or does the MVP support
    only x64/arm64 on Linux, macOS and Windows?

## Minimum viable subset

A faithful-but-minimal port, in the order it would be built. It reports Pi's choices; it does not
choose this repository's contract.

1. **Target table and asset naming.** Six rows (`darwin`/`win32`/`linux` × `x64`/`arm64`), musl on
   Linux, msvc zip on Windows, `fd-v<version>-` / `ripgrep-<version>-` prefixes, and a refusal for
   every other architecture.
2. **Version resolution by redirect.** `releases/latest` with `redirect: "manual"`, validate
   `/releases/tag/`, take the last path segment, strip `v`. Ten-second budget and two immediate
   retries; no API token, no API quota.
3. **Lookup order.** Cache file first (with `.exe` on Windows), then `fd`/`fdfind` and `rg` on
   `PATH`; return the bare name for `PATH` hits and the absolute path for cache hits.
4. **Install.** Download to a file in the cache directory, extract with `tar xzf` (plus
   `System32\tar.exe`/PowerShell on Windows and `unzip`→`tar` on Unix for zips), locate the binary
   (expected path, then recursive search), `chmod 0755` on Unix, `rename` into place, and clean up
   in a `finally`.
5. **Offline and refusal paths.** `<TOOL>_OFFLINE`-style flag, Android/Termux package hint,
   unsupported-architecture message, and a cause-chain error string capped at depth 5. All are
   warnings that leave the tool unavailable rather than throwing.
6. **Injection.** Pass the resolved path into `spawn` inside `grep`/`find`; if `bash` is to see it,
   prepend the cache directory to the child environment's `PATH` in the launcher.
7. **Tests.** Dependency-injected unit tests for the redirect parser and every message (as Pi does),
   one module-level fake for a tool test, and integration tests that skip when the binaries are
   absent; no test downloads.
8. **CI.** Preinstall `ripgrep` and `fd` on Ubuntu (with the `fdfind` symlink) and on
   `windows-2025`; add at least one offline test so the download path is never the only path.

Deliberately out of scope for the subset: update checking, checksums, locking, proxy configuration,
`PI_CODING_AGENT_DIR`-style overrides, resume, and self-healing a corrupt cached binary.

## Decisions the subset leaves open

- **Cache directory and permissions.** `<repo-local>`, `$XDG_CACHE_HOME`, or a new per-user
  `coding-agent` directory; `0700` or default umask; whether evaluation containers get a writable
  copy or must find the binaries preinstalled.
- **Pinning.** Always latest, latest with per-platform fallbacks (Pi's fd/macOS pin), or a
  committed manifest of exact versions and hashes.
- **Checksums.** Require them (and then solve fd, which publishes none), accept TLS-only as Pi
  does, or vendor the binaries.
- **Concurrency and atomicity.** A lock file, a per-process archive name, or Pi's shared archive
  path.
- **Failure surface.** Warnings on a status channel, a tool error code, or a setup command that
  fails before the session starts.
- **Scope of platforms and names.** `fdfind`, Termux, arm32, and whether Windows uses system
  `tar.exe`, a Bun zip library, or a bundled 7-Zip.

## Sources

Pi (all pinned at `8209929fb553e7a8c91dc0894569f9ec43dd201f`):

- [`utils/tools-manager.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/tools-manager.ts) — lines 11–13 (timeouts), 15–19 (offline), 30–40 (targets), 42–58 (tool table), 60–91 (lookup), 93–127 (version), 129–143 (download), 145–165 (binary search), 167–244 (extraction), 246–319 (install), 321–325 (Termux), 327–397 (status and failure).
- [`utils/management-http.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/management-http.ts) — retryable statuses and timeout budget.
- [`utils/pi-user-agent.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/pi-user-agent.ts) and [`packages/ai/src/utils/identity.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/ai/src/utils/identity.ts) — user-agent format.
- [`src/config.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/config.ts) — `CONFIG_DIR_NAME`, `getAgentDir`, `getBinDir`.
- [`src/core/tools/grep.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/grep.ts) and [`src/core/tools/find.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/tools/find.ts) — `ensureTool` use and `spawn`.
- [`src/modes/interactive/interactive-mode.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/modes/interactive/interactive-mode.ts) — startup prefetch and status rendering.
- [`src/utils/shell.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/utils/shell.ts) — `getShellEnv` `PATH` prepend.
- [`src/migrations.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/migrations.ts) — `tools/` → `bin/` migration.
- [`src/core/http-dispatcher.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/src/core/http-dispatcher.ts) — proxy dispatcher.
- [`test/tools-manager.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/tools-manager.test.ts) and [`test/find-abort-before-spawn.test.ts`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/test/find-abort-before-spawn.test.ts) — fakes.
- [`.github/workflows/ci.yml`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/.github/workflows/ci.yml) — Ubuntu-only test jobs, `fd-find ripgrep` install.
- [`.github/workflows/env.yml`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/.github/workflows/env.yml) and [`.github/workflows/build-binaries.yml`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/.github/workflows/build-binaries.yml) — where Pi's Windows runners actually are.
- [`packages/coding-agent/docs/cli.md`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/cli.md), [`docs/environment-variables.md`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/environment-variables.md), [`docs/containerization.md`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/docs/containerization.md) — `--offline`, `PI_OFFLINE`, and the container example.
- [`CHANGELOG.md`](https://github.com/earendil-works/pi/blob/8209929fb553e7a8c91dc0894569f9ec43dd201f/packages/coding-agent/CHANGELOG.md) — lines 182, 1076, 1096, 3646.

Pi commits and issues:

- [`8209929fb553e7a8c91dc0894569f9ec43dd201f`](https://github.com/earendil-works/pi/commit/8209929fb553e7a8c91dc0894569f9ec43dd201f) — research snapshot.
- [57e53b0d](https://github.com/earendil-works/pi/commit/57e53b0d790a5d81fde91542d867bdeba00adada) — redirect-based version resolution and cause-chain messages.
- [c8ec752c](https://github.com/earendil-works/pi/commit/c8ec752cf92a612c340249f1d0abd1bdecaf5b9f) — refuse unmapped architectures.
- [6aedd106](https://github.com/earendil-works/pi/commit/6aedd1066e540642165aa30fa7b4a1b863778aa7) — musl builds on Linux.
- [7afd80d7](https://github.com/earendil-works/pi/commit/7afd80d78801cdd5a9be8c0e018d556605d90784) — fd pin for macOS x64.
- [82caf064](https://github.com/earendil-works/pi/commit/82caf064e0eed2a848ede1f51f16a6f96483034b) — `tar` instead of `unzip` on Windows.
- [5c9ce47c](https://github.com/earendil-works/pi/commit/5c9ce47c53e0a60f7450add52f30b58915beb960) — `pipeline()` and the 120 s download timeout.
- [7ddb7c67](https://github.com/earendil-works/pi/commit/7ddb7c67a86d291518782d50049a366975edf8e7) — Termux package name.
- [3edb8b5c](https://github.com/earendil-works/pi/commit/3edb8b5cb716ec4fec812a7022c559af83ad3121) — `fdfind` fallback.
- [0a736e85](https://github.com/earendil-works/pi/commit/0a736e858d74c862aad10e15440b861b530364f5) — managed binaries moved to `bin/`.
- [Issue #4559](https://github.com/earendil-works/pi/issues/4559) — fd v10.4.2 dropped `x86_64-apple-darwin`.

Release data (read 2026-11-24):

- [fd releases](https://github.com/sharkdp/fd/releases) — latest `v10.5.2`; `x86_64-apple-darwin` absent in `v10.4.2`, present in `v10.5.0` and later; no `.sha256` assets.
- [ripgrep releases](https://github.com/BurntSushi/ripgrep/releases) — latest `16.0.0`; `.sha256` beside every archive.

This repository (at `adb7a73`):

- `packages/tools/src/registry.ts:11-22` — the four registered tools.
- `packages/tools/src/shell.ts:27-68` — `findShell` and `onPath`.
- `packages/tools/src/child-process.ts:30-45` — `Bun.spawn` environment.
- `packages/coding-agent/src/model-port.ts:28` — the current user agent.
- `.github/workflows/ci.yml:69-124` — Linux/Windows test matrix and the macOS job.
- `docs/adr/0001-tool-contracts-and-safety-policy.md:28-31` — the current tool table.
- `docs/adr/0005-terminalbench-evaluation-protocol.md:48-49`, `:301-314`, `:404-410` — task images, compiled binaries, in-container execution.
- `.bun-version:1` — Bun 1.3.14.
