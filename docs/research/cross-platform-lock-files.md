# CDA-136: Cross-platform lock files with stale-lock recovery under Bun

## Question

How can a Bun process take an exclusive lock on Linux, macOS and Windows so that exactly one of
two racing processes wins, and how can a later process tell a lock left by a crashed process from
a lock held by a live one? This feeds CDA-142 ("Decide session locking and same-directory
detection"), which must satisfy five planned behaviours:

1. A saved Session (a JSONL file) is open in at most one terminal; a second terminal is always
   refused, even when two terminals pick the same Session at the same moment.
2. A lock left by a crash never blocks forever.
3. `--continue` reports clearly when the latest Session is open elsewhere.
4. The resume list shows Sessions open elsewhere as dimmed.
5. Coding Agent warns when another Coding Agent is already running in the same directory.

## Short answer

- **Exclusive create works everywhere through `node:fs` in Bun.** `open(path, "wx")`,
  non-recursive `mkdir` and `link` each let exactly one racer succeed; the others get `EEXIST`.
  On Windows, Bun routes these calls through libuv, which maps `wx` to `CreateFileW` with
  `CREATE_NEW`. A macOS experiment with 8 racing Bun processes over 200 rounds produced exactly
  one winner per round for each of the three primitives. `rename` cannot acquire a lock, because
  it silently replaces an existing target on every platform.
- **Bun exposes no OS lock that dies with the process.** There is no `flock`, `fcntl` or
  `LockFileEx` in `node:fs` or Bun's API; Bun drops libuv's Windows exclusive-share flag; only
  macOS lets the raw `O_EXLOCK` bit through. Kernel-released locks need `bun:ffi`, which Bun
  labels experimental, or a presence endpoint (a named pipe on Windows is removed when its owner
  exits; a Unix socket file is not).
- **A crash leaves a file-based lock behind.** `SIGKILL`, and `SIGTERM`, `SIGINT` or `SIGHUP`
  without a handler, skip `exit` handlers. Recovery needs a liveness test: `process.kill(pid, 0)`
  (POSIX `kill`, libuv `uv_kill` on Windows; `ESRCH` means gone, `EPERM` means alive), a
  heartbeat on the lock's mtime (proper-lockfile), or an age limit (git's `gc.pid`, 12 hours).
- **PIDs are reused, so a PID alone is weak evidence.** Linux wraps at 32768 by default, macOS at
  99999, and Windows frees a PID when its process ends. Claude Code's changelog records stale
  locks pointing at reused PIDs, one of them on Windows. Recording the hostname and the boot time
  next to the PID narrows this; recording the process start time narrows it further but has no
  cross-platform Bun API.
- **Reclaiming a stale lock is its own race.** "Check stale, delete, re-create" lets two
  reclaimers both win. proper-lockfile has an open issue for exactly this; git's `gc` avoids it by
  doing the check and the rewrite under a second, short-lived `O_EXCL` lock.
- **Pi does not lock sessions**, and two auto-closed Pi issues describe the resulting forked
  session trees. **Claude Code** does detect conversations open in another process (per its
  changelog), but its implementation is not public. **git** never removes `index.lock` on its own.

## Research basis

Research date: 2026-11-23. Source code is cited at these commits:

| Source | Pin |
| --- | --- |
| Bun 1.3.14 (the version in this repo's `.bun-version`) | tag `bun-v1.3.14`, [`0d9b296`](https://github.com/oven-sh/bun/tree/0d9b296af33f2b851fcbf4df3e9ec89751734ba4) |
| libuv as vendored by Bun 1.3.14 (Windows only) | `oven-sh/libuv` [`4dcfac4`](https://github.com/oven-sh/libuv/tree/4dcfac4780d394e0dc2d3fb30335ca01b553eb46), named in [`scripts/build/deps/libuv.ts` L1-L16](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/scripts/build/deps/libuv.ts#L1-L16) |
| Node.js docs | `nodejs/node` main [`660c104`](https://github.com/nodejs/node/tree/660c1040592c4332520e7d783360139c8298cb52) |
| git | `git/git` master [`f7de814`](https://github.com/git/git/tree/f7de81456940dd6f3274e461149bba12965de609) |
| proper-lockfile | v4.1.2 [`9f8c303`](https://github.com/moxystudio/node-proper-lockfile/tree/9f8c303c91998e8404a911dc11c54029812bca69) (the latest tag and the repository head, committed 2021-01-25) |
| Pi | `earendil-works/pi` main [`69a6993`](https://github.com/earendil-works/pi/tree/69a6993486acee850d14a4a1547daa4a167228ad) |
| Claude Code changelog | `anthropics/claude-code` main [`671acef`](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md) (the repository publishes the changelog, not the CLI source) |
| XNU (macOS kernel) | `apple-oss-distributions/xnu` [`f6217f8`](https://github.com/apple-oss-distributions/xnu/tree/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea) |

Specifications and vendor docs: POSIX.1-2024 ([`open`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html),
[`mkdir`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/mkdir.html),
[`rename`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html),
[`kill`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/kill.html)), Linux man-pages
([`open(2)`](https://man7.org/linux/man-pages/man2/open.2.html),
[`flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html),
[`unix(7)`](https://man7.org/linux/man-pages/man7/unix.7.html),
[`proc_sys_kernel(5)`](https://man7.org/linux/man-pages/man5/proc_sys_kernel.5.html),
[`proc_pid_stat(5)`](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)) and Microsoft
Learn (linked where used).

### Experiments (macOS only)

All experiments ran on macOS 27.2.1 (APFS) with Bun 1.3.14, in a temporary directory outside the
repository. **Linux and Windows were not tested**; everything said about them below comes from
source and documentation.

1. **Race.** A driver spawned 8 Bun processes per round. Each busy-waited until a shared start
   time 300 ms ahead, then tried one primitive on the same path: `openSync(path, "wx")`,
   `mkdirSync(path)`, or `writeFileSync` of a private file followed by `linkSync(private, path)`.
   200 rounds per primitive:

   ```text
   wx: 200 rounds x 8 processes; winners per round {"1":200}; loser errors {"lost:EEXIST":1400}
   mkdir: 200 rounds x 8 processes; winners per round {"1":200}; loser errors {"lost:EEXIST":1400}
   link: 200 rounds x 8 processes; winners per round {"1":200}; loser errors {"lost:EEXIST":1400}
   ```

2. **Liveness and leftovers.** A holder process took a `wx` lock and registered
   `process.on("exit")` to delete it (and, where noted, `SIGINT`/`SIGTERM`/`SIGHUP` handlers
   that call `process.exit`). The driver then killed it, probed PIDs, tried macOS `O_EXLOCK`
   (`0x20`) through `openSync`'s numeric flags, and tried a `node:net` Unix socket as a presence
   endpoint:

   ```text
   process.kill(process.pid, 0): alive (returned true)
   process.kill(1, 0) [launchd, owned by root]: threw code=EPERM errno=1
   live child 10683: alive (returned true)
   same pid after SIGKILL and reap: threw code=ESRCH errno=3
   wx lock, holder killed by SIGKILL, signal handlers none: lock file LEFT BEHIND
   wx lock, holder killed by SIGTERM, signal handlers none: lock file LEFT BEHIND
   wx lock, holder killed by SIGTERM, signal handlers signals: lock file removed
   wx lock, holder killed by SIGINT, signal handlers none: lock file LEFT BEHIND
   wx lock, holder killed by SIGHUP, signal handlers signals: lock file removed
   O_EXLOCK|O_NONBLOCK while holder alive: failed code=EAGAIN
   O_EXLOCK|O_NONBLOCK after holder SIGKILL: opened (lock acquired)
   second listen on same unix path while holder alive: error code=EADDRINUSE
   connect while holder alive: connected (holder alive)
   after holder SIGKILL: socket file still exists, connect: error code=ENOENT
   ```

3. **Stale socket error code.** Bun's `node:net` and `Bun.connect` both reported `ENOENT` for the
   leftover socket (`lstat` still showed a socket), and a new `listen` on that path failed with
   `EADDRINUSE`. The same scenario in Python (`python3 -I`, `socket.connect`) got
   `errno=61 (Connection refused)` from the OS, so the `ENOENT` is Bun's error mapping, not the
   kernel's.
4. **Boot time.** `Date.now() - os.uptime() * 1000` matched `sysctl kern.boottime` to the second;
   two samples 1.5 s apart differed by 498 ms, because `os.uptime()` returned whole seconds.

## Findings

### 1. Acquiring: which primitives let exactly one racer win

#### 1.1 Exclusive create (`wx`, `O_EXCL`, `CREATE_NEW`)

- POSIX makes the existence check and the creation under `O_CREAT | O_EXCL` atomic with respect
  to other `open()` calls using the same flags on the same name, and fails with `EEXIST` on a
  symbolic link whatever it points to ([POSIX `open`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html)).
- Node documents `'wx'` as "Like `'w'` but fails if the path exists", says Windows translates
  `O_EXCL|O_CREAT` to `CREATE_NEW`, and warns that the exclusive flag "might not work with network
  file systems" ([fs.md L9669-L9684](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/fs.md#L9669-L9684)).
  Linux's `open(2)` narrows that: on NFS, `O_EXCL` works only with NFSv3 or later on kernel 2.6
  or later, and the page gives a `link(2)`-based recipe for the other cases ([open(2)](https://man7.org/linux/man-pages/man2/open.2.html)).
- Bun maps `"wx"` to `O_TRUNC | O_CREAT | O_WRONLY | O_EXCL` ([types.zig L1016](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/node/types.zig#L1016)).
  On Windows, Bun's `node:fs` uses the libuv-backed syscall layer ([node_fs.zig L7300](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/node/node_fs.zig#L7300)),
  so `openSync` calls `uv_fs_open` ([sys_uv.zig L22-L40](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/sys/sys_uv.zig#L22-L40)),
  and libuv turns `CREAT | EXCL` into `CREATE_NEW` ([fs.c L489-L499](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/fs.c#L489-L499)).
  `CreateFileW` with `CREATE_NEW` fails with `ERROR_FILE_EXISTS` when the file exists
  ([CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)),
  which libuv reports as `EEXIST` ([error.c L97](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/error.c#L97)).
- `writeFileSync(path, data, { flag: "wx" })` takes a different Windows path in Bun: it calls
  `bun.sys.openat` ([node_fs.zig L5452-L5462](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/node/node_fs.zig#L5452-L5462)),
  which uses `NtCreateFile` with `FILE_CREATE` for `O_CREAT | O_EXCL` ([sys.zig L1648-L1651](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/sys/sys.zig#L1648-L1651)).
  Both paths open with read, write and delete sharing ([fs.c L474-L487](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/fs.c#L474-L487),
  [sys.zig L4236](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/sys/sys.zig#L4236)),
  so an open lock file never blocks other readers on Windows.
- Gap: the file exists, empty, between the `wx` open and the write of the owner record. A
  reader in that window sees no owner. Writing the record to a private file first and then
  `link`ing it to the lock name (section 1.3) publishes name and content at once.

#### 1.2 Directory lock (`mkdir`)

- POSIX `mkdir` fails with `EEXIST` when "the named file exists" ([POSIX `mkdir`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/mkdir.html));
  Node raises `EEXIST` when `recursive` is false and the directory exists ([fs.md L4026-L4029](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/fs.md#L4026-L4029)).
  With `recursive: true` an existing directory is not an error, so it cannot be a lock.
- Bun on Windows calls `uv_fs_mkdir` ([sys_uv.zig L42-L51](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/sys/sys_uv.zig#L42-L51)),
  which is `CreateDirectoryW` ([fs.c L1255-L1265](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/fs.c#L1255-L1265)).
- proper-lockfile chose `mkdir` because it "works atomically on any kind of file system, even
  network based ones", unlike `O_EXCL` on NFS ([README L25-L47](https://github.com/moxystudio/node-proper-lockfile/blob/9f8c303c91998e8404a911dc11c54029812bca69/README.md#L25-L47)).
  That is the library's claim; it was not tested here.
- A directory carries no content atomically. Owner data must go in a file inside it (two steps to
  create, two to remove) or be left out, as proper-lockfile does.

#### 1.3 `rename` and `link`

- `rename` replaces an existing target: POSIX removes the existing entry and keeps the name
  visible throughout ([POSIX `rename`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)),
  Node documents the overwrite ([fs.md L4932-L4937](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/fs.md#L4932-L4937)),
  and libuv on Windows passes `MOVEFILE_REPLACE_EXISTING` ([fs.c L2292-L2299](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/fs.c#L2292-L2299)).
  Bun's internal syscall layer knows `RENAME_NOREPLACE` (Linux) and `RENAME_EXCL` (macOS)
  ([sys.zig L2508-L2527](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/sys/sys.zig#L2508-L2527)),
  but `fs.rename` does not use them ([node_fs.zig L5717-L5727](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/node/node_fs.zig#L5717-L5727)).
  So `rename` is for publishing content atomically (git commits a lock by renaming
  `<file>.lock` over `<file>`), or for claiming a known stale lock (section 2.5), not for
  acquiring.
- `link` fails if the new name exists, and Linux's man page recommends creating a unique file and
  then `link`ing it to the lock name as the NFS-safe lock ([open(2)](https://man7.org/linux/man-pages/man2/open.2.html)).
  Bun on Windows calls `uv_fs_link` ([sys_uv.zig L182-L192](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/sys/sys_uv.zig#L182-L192)),
  which is `CreateHardLinkW` ([fs.c L2724-L2730](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/fs.c#L2724-L2730)).
  Microsoft documents hard links as NTFS-only, lists ReFS as unsupported, and requires both names
  on the same volume ([CreateHardLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw)).

#### 1.4 OS-held locks (released by the kernel when the process dies)

- Neither Node's `fs` docs ([fs.md](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/fs.md))
  nor Bun's type definitions ([bun.d.ts](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/packages/bun-types/bun.d.ts))
  mention `flock` or `fcntl` locking; I found no lock API in either.
- Windows: libuv can open with share mode 0 when given `UV_FS_O_EXLOCK` ([fs.c L474-L487](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/fs.c#L474-L487)),
  and share mode 0 blocks every later open until the handle closes ([CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)).
  Bun's flag translation has no branch for that bit, so it is dropped ([libuv.zig L199-L223](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/libuv_sys/libuv.zig#L199-L223)),
  and Node's list of flags available on Windows does not include it either ([fs.md L9097-L9100](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/fs.md#L9097-L9100)).
- macOS: `open` accepts `O_EXLOCK` (`0x20`), a lock with `flock` semantics, and fails with
  `EWOULDBLOCK` under `O_NONBLOCK` when the file is locked ([fcntl.h L121-L122](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/fcntl.h#L121-L122),
  [open.2 L199-L210, L494-L495](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/man/man2/open.2#L199-L210)).
  Bun 1.3.14 passed the raw bit through and the lock was released on `SIGKILL` (experiment 2).
  Bun does not export the constant, so this pass-through is undocumented behaviour. Linux has no
  equivalent `open` flag.
- With `bun:ffi`, a process could call `flock` (released when the last descriptor on the open
  file description closes, advisory only, emulated with `fcntl` byte-range locks on NFS since
  Linux 2.6.12; [flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)) or `LockFileEx`
  (exclusive locks deny other processes read and write access to the range; the OS unlocks them
  when the process ends, but "the time it takes ... depends upon available system resources";
  [LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex)).
  Bun's docs warn that `bun:ffi` "is **experimental**, with known bugs and limitations, and should
  not be relied on in production" ([ffi.mdx L6-L9](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/docs/runtime/ffi.mdx#L6-L9)).
- Because `LockFileEx` denies reads of the locked range, locking the Session JSONL itself would
  stop other processes from reading it, for example to build the resume list. A separate lock
  file avoids that.

#### 1.5 Presence endpoints (named pipe, Unix socket)

- On Windows, Node's local IPC endpoint is a named pipe, which Windows closes and removes when
  the owning process exits; on Unix it is a socket file that stays until someone unlinks it, even
  after a crash, while Linux abstract sockets (`\0name`) disappear with their last reference ([net.md L43-L64](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/net.md#L43-L64)).
  The same page limits Unix socket paths to about 107 bytes on Linux and 103 on macOS.
- Bun's `Bun.listen` on a Windows pipe name binds through libuv ([Listener.zig L1046](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/socket/Listener.zig#L1046),
  [libuv.zig L1432-L1444](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/libuv_sys/libuv.zig#L1432-L1444)).
  libuv creates the first instance with `FILE_FLAG_FIRST_PIPE_INSTANCE` and returns `EADDRINUSE`
  if a server already exists ([pipe.c L778-L793](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/pipe.c#L778-L793));
  Windows guarantees only one instance succeeds with that flag ([CreateNamedPipeW](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew)).
  So on Windows a named pipe is both an exclusive acquire and a crash-safe release. Whether
  `node:net` `listen` in Bun takes the same path was not traced.
- On POSIX, `bind` fails with `EADDRINUSE` while the socket file exists, live or not, and
  `connect` to a file with no listener fails with `ECONNREFUSED` ([unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html)).
  A stale socket must therefore be probed and unlinked, which is the same reclaim race as in
  section 2.5. Bun reports that probe failure as `ENOENT` rather than `ECONNREFUSED`
  (experiment 3).

### 2. Telling a crashed holder from a live one

#### 2.1 What a crash leaves behind

- Node emits `exit` only on `process.exit()` or an empty event loop ([process.md L101-L108](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/process.md#L101-L108)).
  `SIGTERM` and `SIGINT` have default handlers that exit with `128 + signal`, and `SIGHUP`
  terminates by default; on Windows `SIGHUP` arrives when the console window closes and the
  process is killed about 10 seconds later regardless ([process.md L695-L706](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/process.md#L695-L706)).
  Experiment 2 matched this under Bun: without signal handlers, `SIGTERM` and `SIGINT` left the
  lock file; with handlers that call `process.exit`, `SIGTERM` and `SIGHUP` removed it; `SIGKILL`
  always left it.
- git and proper-lockfile both clean up from `atexit`/signal handlers and accept that `SIGKILL`
  and hard crashes leave the lock ([lockfile.h L18-L25](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/lockfile.h#L18-L25),
  [README L168-L170](https://github.com/moxystudio/node-proper-lockfile/blob/9f8c303c91998e8404a911dc11c54029812bca69/README.md#L168-L170)).
  Power loss or a reboot also leaves file-based locks, now owned by PIDs from a previous boot.

#### 2.2 `process.kill(pid, 0)` under Bun

- POSIX: signal 0 does error checking without sending; `ESRCH` means no such process, `EPERM`
  means it exists but the caller may not signal it ([POSIX `kill`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/kill.html)).
  Node documents signal 0 as an existence test on every platform ([process.md L725-L726](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/process.md#L725-L726),
  [L2727-L2730](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/process.md#L2727-L2730)).
- Bun calls `kill(2)` on POSIX and libuv `uv_kill` on Windows ([BunProcess.cpp L4098-L4125](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/jsc/bindings/BunProcess.cpp#L4098-L4125)),
  then throws a `SystemError` whose `code` comes from `Bun__errnoName` ([BunProcess.cpp L4176-L4183](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/jsc/bindings/BunProcess.cpp#L4176-L4183),
  [helpers.cpp L22-L38](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/jsc/bindings/helpers.cpp#L22-L38)).
  On macOS this gave `ESRCH` for a reaped child and `EPERM` for `launchd` (experiment 2).
- On Windows, `uv_kill` opens the process with `PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION |
  SYNCHRONIZE`; libuv reads `ERROR_INVALID_PARAMETER` as "no such process" (`ESRCH`), other failures are
  translated, so `ERROR_ACCESS_DENIED` becomes `EPERM` ([process.c L1429-L1454](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/process.c#L1429-L1454),
  [error.c L158](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/error.c#L158)).
  For signal 0 it then reports `ESRCH` if the exit code is not `STILL_ACTIVE` or the handle is
  already signalled ([process.c L1382-L1400](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/process.c#L1382-L1400)),
  which covers Microsoft's warning that a process can exit with code 259 and look alive
  ([GetExitCodeProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess)).
  Bun negates libuv's negative code and looks up the `UV_` name, so the `code` should read
  `ESRCH` or `EPERM` as on POSIX ([sys.zig L4250-L4252](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/sys/sys.zig#L4250-L4252),
  [windows_errno.zig L1097-L1098](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/errno/windows_errno.zig#L1097-L1098)).
  This was read from source, not run on Windows.
- git treats `EPERM` as alive in both places it probes a PID ([lockfile.c L273-L278](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/lockfile.c#L273-L278),
  [gc.c L466](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/builtin/gc.c#L466)).
  A holder running elevated or as another user must not be treated as dead.

#### 2.3 PID reuse

- Linux PIDs wrap at `pid_max`, default 32768, settable up to about 4 million on 64-bit
  ([proc_sys_kernel(5)](https://man7.org/linux/man-pages/man5/proc_sys_kernel.5.html)). macOS
  caps PIDs at 99999 ([proc_internal.h L753](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/proc_internal.h#L753)).
  A Windows PID is valid "from the time the process is created until the process has been
  terminated" ([Process Handles and Identifiers](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers)).
- In practice: Claude Code fixed background agents that never restarted after "a stale
  `daemon.lock` whose PID the OS reused" (2.1.200, [L6945](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L6945)),
  the same on Windows (2.1.257, [L5503](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L5503)),
  and `claude daemon stop --any` "potentially terminating an unrelated process via a stale legacy
  daemon lockfile" (2.1.216, [L6521](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L6521)).
  git's lock message says the lock "may be stale (PIDs can be reused)" even when the PID is alive
  ([lockfile.c L280-L284](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/lockfile.c#L280-L284)).
- Extra identity that narrows reuse:
  - **Hostname.** git's `gc.pid` stores `<pid> <hostname>` and only probes the PID when the
    hostname is its own ([gc.c L436-L466](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/builtin/gc.c#L436-L466));
    `os.hostname()` is available ([os.md L220-L228](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/os.md#L220-L228)).
    This also covers a home directory shared over the network, where a remote PID means nothing
    locally.
  - **Boot time.** `Date.now() - os.uptime() * 1000`; `os.uptime()` returns whole seconds
    ([os.md L451-L464](https://github.com/nodejs/node/blob/660c1040592c4332520e7d783360139c8298cb52/doc/api/os.md#L451-L464)),
    so comparisons need about a second of tolerance (experiment 4). A different boot time proves
    the holder is gone, which handles the reboot case. Only checked on macOS.
  - **Process start time.** Linux exposes it as field 22 of `/proc/<pid>/stat`, in clock ticks
    since boot ([proc_pid_stat(5)](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)).
    I found no Node or Bun API that returns another process's start time on macOS or Windows; it
    would need a native call (FFI) or a helper process.
  - **Instance id** (a random token in the lock). It lets a holder recognise its own lock, but
    another process cannot query it, so it does not help a liveness probe.

#### 2.4 Heartbeat leases (time-based staleness)

- proper-lockfile refreshes the lock directory's mtime every `update` ms (default `stale / 2`)
  and treats a lock whose mtime is older than `stale` (default 10 s) as stale
  ([README L25-L32, L76](https://github.com/moxystudio/node-proper-lockfile/blob/9f8c303c91998e8404a911dc11c54029812bca69/README.md#L25-L32),
  [lockfile.js L84-L86, L205-L221](https://github.com/moxystudio/node-proper-lockfile/blob/9f8c303c91998e8404a911dc11c54029812bca69/lib/lockfile.js#L205-L221)).
  The README says the minimum `stale` is 5000 ms; the code clamps to 2000 ms.
- The holder checks on each refresh that the mtime is still the one it wrote, and calls
  `onCompromised` (default: throw) if not, or if a refresh is late past the threshold
  ([lockfile.js L99-L183](https://github.com/moxystudio/node-proper-lockfile/blob/9f8c303c91998e8404a911dc11c54029812bca69/lib/lockfile.js#L99-L183)).
  The README admits it cannot detect a lock removed by hand and re-acquired, or two processes
  using different `stale` values ([README L50-L61](https://github.com/moxystudio/node-proper-lockfile/blob/9f8c303c91998e8404a911dc11c54029812bca69/README.md#L50-L61)).
- Strengths: no PIDs, so no reuse problem; works across machines. Weaknesses: a live holder that
  cannot refresh in time (blocked event loop, a suspended laptop that wakes while another process
  is already checking) looks stale and gets its lock taken; the holder only learns this on its
  next refresh. Claude Code shipped a fix for "running versions getting removed because lock file
  incorrectly going stale" (2.0.62, [L10612](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L10612)).
  A crashed holder blocks others for up to `stale`; Claude Code fixed a lock left by a killed
  process that made requests fail "for up to a minute" (2.1.282, [L4137](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L4137)).

#### 2.5 Reclaiming a stale lock safely

- The naive reclaim is "read, decide stale, delete, create". If two processes decide at the same
  time, the slower one can delete the lock the faster one just created, and both proceed.
  proper-lockfile does exactly this (`stat`, `rmdir`, `mkdir`; [lockfile.js L46-L80](https://github.com/moxystudio/node-proper-lockfile/blob/9f8c303c91998e8404a911dc11c54029812bca69/lib/lockfile.js#L46-L80)),
  and the race is reported in the open issue [#121](https://github.com/moxystudio/node-proper-lockfile/issues/121).
  Claude Code fixed "a rare auth failure when two sessions recover a login refresh lock left by a
  crashed process at the same time" (2.1.285, [L3828](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L3828)).
- Known ways around it:
  - **Guard lock.** git `gc` takes `gc.pid.lock` with `O_EXCL` (dying if it exists), reads
    `gc.pid`, decides, writes its own `pid hostname` into the lock file and renames it over
    `gc.pid` ([gc.c L421-L486](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/builtin/gc.c#L421-L486)).
    The check-and-replace is serialised by the short-lived guard; only a crash inside that short
    window leaves the guard behind.
  - **Claim by rename.** Rename the stale lock to a unique name, so only one reclaimer's rename
    succeeds, then verify what was renamed. A comment on issue #121 describes a fork that does
    this; it was not reviewed here.
  - **No reclaim at all.** OS-held locks (section 1.4) and Windows named pipes (section 1.5) are
    released by the kernel, so nobody deletes anything.

### 3. How established tools handle staleness

| Tool | Acquire | Liveness or staleness | Reclaim |
| --- | --- | --- | --- |
| git `index.lock` and other `*.lock` | `O_CREAT \| O_EXCL` on `<file>.lock`, commit by `rename` ([lockfile.h L4-L30](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/lockfile.h#L4-L30)) | None by default. With `core.lockfilePid` (in the docs from v2.54.0, absent in v2.53.0), a `~pid` file lets the error message say whether the PID runs ([core.adoc L358-L367](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/Documentation/config/core.adoc#L358-L367), [lockfile.c L112-L139, L254-L300](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/lockfile.c#L254-L300)) | Never automatic; the user deletes the file. Optional retry with quadratic backoff ([lockfile.c L206-L252](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/lockfile.c#L206-L252)) |
| git `gc.pid` | Guard `gc.pid.lock` via `O_EXCL`, then rewrite `gc.pid` | Stale if older than 12 hours, or same host and `kill(pid, 0)` fails with anything but `EPERM` ([gc.c L449-L466](https://github.com/git/git/blob/f7de81456940dd6f3274e461149bba12965de609/builtin/gc.c#L449-L466)) | Under the guard lock; `--force` skips the check |
| proper-lockfile 4.1.2 | `mkdir <file>.lock` | mtime heartbeat, `stale` 10 s default | `rmdir` then `mkdir`, racy (section 2.5) |
| Pi | Sessions: none. Settings and `auth.json`: proper-lockfile 4.1.2 ([package.json L60](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/package.json#L60)) | proper-lockfile's; `auth.json` uses `stale: 30_000` and retries `ELOCKED`, plus `EPERM` on Windows only (at most 5 `EPERM` retries in the async path) ([auth-storage.ts L22-L29, L118-L150](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/auth-storage.ts#L118-L150)) | proper-lockfile's |
| Claude Code | Not public | Changelog shows PID lock files, stale sweeps, and a stale `daemon.lock` with a reused PID (section 2.3) | Not public |

- **Pi sessions.** `SessionManager._persist` creates the Session file with `openSync(file, "wx")`
  on first write and appends with `appendFileSync` afterwards, with no lock
  ([session-manager.ts L1182-L1199](https://github.com/earendil-works/pi/blob/69a6993486acee850d14a4a1547daa4a167228ad/packages/coding-agent/src/core/session-manager.ts#L1182-L1199)).
  Issue [#8300](https://github.com/earendil-works/pi/issues/8300) reports two processes appending
  to one session JSONL and forking its tree; issue [#12266](https://github.com/earendil-works/pi/issues/12266)
  reports an idle second instance appending under a stale leaf so that resume lands on an empty
  branch. Both were closed automatically as "not planned" (the bot closes issues from new
  contributors). A commenter on #8300 guards with an extension that takes `flock` on
  `<session-file>.lock` and notes that Pi may already have written `model_change` entries before
  any extension hook runs. The lesson for us: the lock must be taken before anything opens the
  Session for writing.
- **Claude Code sessions.** The changelog shows the product detects conversations open in another
  process and asks rather than silently opening a second copy: the VS Code extension "now asks
  first" (2.1.284 and 2.1.285, [L3997](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L3997),
  [L3900](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L3900)),
  and `claude agents` shows a stopped session resumed elsewhere as "open in a terminal" (2.1.248,
  [L5702](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L5702)).
  It also swept "plugin `.in_use` PID lock files accumulating without bound" (2.1.169,
  [L7385](https://github.com/anthropics/claude-code/blob/671acefa8e509e04911102476173742ba2b2cdc4/CHANGELOG.md#L7385)),
  which is the failure mode of per-process marker files that nobody garbage-collects. How it
  detects an open conversation is not documented.

### 4. Windows-specific failure modes

- **Delete pending.** With legacy delete semantics a deleted file stays until its last handle
  closes, and `CreateFile` on that name fails with `ERROR_ACCESS_DENIED`; with POSIX delete the
  name goes at once ([DeleteFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew),
  [FILE_DISPOSITION_INFORMATION_EX](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntddk/ns-ntddk-_file_disposition_information_ex)).
  Bun's `unlink` and `rmdir` go through libuv ([node_fs.zig L6063-L6069](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/runtime/node/node_fs.zig#L6063-L6069)),
  which tries POSIX delete first and falls back on file systems or Windows versions without it
  ([fs.c L1165-L1195](https://github.com/oven-sh/libuv/blob/4dcfac4780d394e0dc2d3fb30335ca01b553eb46/src/win/fs.c#L1165-L1195)).
  On the fallback path a lock released and re-taken quickly can fail with `EPERM`
  (`ERROR_ACCESS_DENIED` in libuv). Pi's `EPERM`-on-Windows retry (section 3) is consistent with
  this, though Pi's code does not state the cause.
- **Sharing.** Bun always opens with full sharing (section 1.1), so an open lock file does not
  stop anyone; only the exclusive create does.
- **PID probe needs `PROCESS_TERMINATE` access.** A holder running elevated can make the probe
  fail with access denied, which maps to `EPERM` and must be read as "alive" (section 2.2).
- **Path identity for same-directory detection.** Windows names are case-insensitive by default,
  including drive letters ([Naming Files](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)),
  and this repo already normalises Git Bash, MSYS, Cygwin and WSL drive paths (AGENTS.md,
  Platforms). Two spellings of one directory must map to one key.

## Implications for CDA-142

The five behaviours split into three needs: an **atomic acquire** (behaviour 1), a **staleness
rule** (behaviour 2), and a **non-acquiring read** that says who holds a Session (behaviours 3
and 4). Behaviour 5 is presence, not exclusion: two Coding Agents in one directory are allowed,
so it needs a registry that every instance can read, not a lock only one can hold.

### Options for the Session lock

**A. `wx` lock file with an owner record, PID-based liveness.** Create `<session>.lock` (or a
lock under a central directory keyed by Session id) with `wx`, holding PID, hostname, boot time,
start time where available, and an instance id; remove it on exit and on handled signals.
Liveness: same hostname, same boot time, and `process.kill(pid, 0)` not `ESRCH`.

- Meets 1 on all three OSes through `node:fs` alone; meets 3 and 4 cheaply (read a small file,
  one `kill(pid, 0)` per Session).
- PID reuse can still keep a dead lock "alive" until reboot; on Linux, comparing the start time
  closes that, elsewhere it stays open unless start time comes from FFI or a helper process. The
  user then needs a way out (a `--force`-style override, as git `gc` has).
- The empty-file window after `wx` (section 1.1), or the `link` variant to avoid it, which is
  NTFS-only on Windows.
- Reclaim must be guarded (section 2.5), adding a second lock file and its own crash window.
- Windows delete-pending may need a short retry on `EPERM`, as Pi does.

**B. Directory lock with a heartbeat (proper-lockfile or a re-implementation).**

- Meets 1, and 2 within `stale`; no PID reuse problem; works across machines.
- Needs a timer in every Coding Agent process for the life of the Session; a blocked event loop
  or a suspend and resume can make a live holder look stale and lose its lock (section 2.4).
- The stock reclaim is racy (#121); the stock library's latest tag is from January 2021 and it
  keeps no owner record, so 3 could only say "open elsewhere", not by whom.
- Using the library adds a third-party runtime dependency to `packages/coding-agent`, whose
  `dependencies` list only workspace packages today.

**C. Kernel-held lock through `bun:ffi` (`flock` on Linux and macOS, `LockFileEx` on Windows) plus
a readable owner file.**

- Meets 1 and 2 with no staleness logic: the kernel releases on death, PIDs do not matter.
- `bun:ffi` is experimental by Bun's own docs; three platform code paths; CI runs Linux and
  Windows on each PR, macOS only after merge (AGENTS.md).
- For 3 and 4, a reader must either try-and-release the lock (a probe that can collide with a real
  opener for a moment) or trust the owner file, which can itself be stale.
- On macOS alone, the raw `O_EXLOCK` bit gives this without FFI (experiment 2), but it is
  undocumented in Bun and does not exist on Linux.

**D. Presence endpoint per Session (named pipe on Windows, Unix socket on POSIX).**

- Windows: exclusive bind and automatic cleanup in one primitive, through Bun's libuv pipe
  server (section 1.5).
- POSIX: the socket file survives a crash, so reclaim needs probe plus unlink (the section 2.5
  race again), and Bun reports the probe as `ENOENT`, not `ECONNREFUSED`. Linux abstract sockets
  avoid the file but are Linux-only.
- Unix socket paths are limited to about 103 bytes on macOS and 107 on Linux (section 1.5), so
  names must be short hashes in a short directory.
- A live endpoint can also answer "who are you" for 3 and 4, at the cost of a listener in every
  process.

Hybrids are possible, for example C or D for exclusion with an owner file as in A for display.

### Cross-cutting choices

- **Order of lock and first write.** Pi's issue shows that any write before the lock check
  (model or setting entries) lands in the holder's file even when the second process is then
  refused. Behaviour 1 holds only if the lock is taken before anything writes to the Session.
- **Lock file next to the JSONL or in a central directory.** Next to it keeps one Session's state
  together; central keeps the sessions directory free of debris that resume-list scanning must
  skip and makes a sweep of stale entries one directory read.
- **Locking the JSONL itself.** With `LockFileEx` on Windows this would block other processes
  from reading the locked range, including the resume list (section 1.4); a separate lock file
  does not have that effect.
- **What `--continue` shows.** Only options A, C-with-owner-file and D carry enough to say which
  process holds the Session (PID, start time, maybe the terminal); stock proper-lockfile (B) can
  only say "in use".
- **Same-directory warning (behaviour 5).** A per-instance record (PID, hostname, boot time,
  canonical working directory) written at start and removed at exit, scanned by each new
  instance after it has written its own record, so two simultaneous starts see each other.
  Records from dead instances must be swept, or they accumulate as Claude Code's `.in_use`
  markers did. The directory key must be canonical (`realpath`, case folding where the file
  system is case-insensitive, as Windows is by default, and the repo's MSYS and WSL
  normalisation). An exclusive
  per-directory lock is the wrong shape: once the first holder exits, a third instance would not
  see the second.

## Not settled by the sources

- **Windows and Linux behaviour was not run.** The `wx`, `mkdir` and `link` races,
  `process.kill(pid, 0)` codes, delete-pending frequency and the named-pipe path are read from
  Bun and libuv source. The experiment scripts could become tests in CI, which already runs on
  Linux and Windows for each pull request.
- **Network file systems** (NFS, SMB home directories) were not tested; only vendor claims are
  cited.
- **Another process's start time** on macOS and Windows has no Bun or Node API that I found.
- **Claude Code's session-detection mechanism** is not public; only its changelog is.
- **macOS `O_EXLOCK` pass-through** in Bun is observed, not documented, and may change.
- **Whether Bun's `node:net` `listen`** on a Windows pipe name goes through the same libuv bind as
  `Bun.listen` was not traced.
