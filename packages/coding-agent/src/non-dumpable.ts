// ADR 0001 §8 rule 2, Agent non-recovery. Removing a provider credential from a child's
// environment (rule 1, in @coding-agent/tools) blocks only the inherited copy. The credential stays
// in this process's /proc/<pid>/environ and memory, because a delete inside the process does not
// rewrite the environment region that execve fixed. On Linux a same-uid process can open this
// process's /proc/<pid>/environ, /proc/<pid>/mem and the links in /proc/<pid>/fd unless this
// process is non-dumpable. cli.ts calls markProcessNonDumpable right after argument parsing, ahead
// of configuration and command dispatch, so the call precedes every Tool Call and Verification
// child, on every entry point and under both Approval Policies.
//
// Limits of the guarantee (see also the package README):
// - A child with CAP_SYS_PTRACE can still read these files, for example root with the full
//   capability set on a host. Under "auto-approve" ptrace-capability.ts removes the capability
//   from this process first, so a child starts without it; under "ask" the limit stays.
// - A reader with CAP_SYS_ADMIN or CAP_PERFMON can still open /proc/<pid>/environ, though not
//   mem or the fd links: mm_access falls back to perfmon_capable() for read access. The file is
//   root-owned once this process is non-dumpable, so such a reader must also be root or hold
//   CAP_DAC_OVERRIDE or CAP_DAC_READ_SEARCH. Docker's default capability set has neither
//   CAP_SYS_ADMIN nor CAP_PERFMON, so root in a default container is denied all three files.
// - A caller with DAC override, such as root or a holder of CAP_DAC_OVERRIDE or
//   CAP_DAC_READ_SEARCH, can still list the fd numbers in /proc/<pid>/fd. It cannot follow them.
// - It protects only this process. An ancestor that still holds the credential, such as the shell
//   that exported it, stays readable. Under "auto-approve" the startup ancestor check in
//   ancestor-credentials.ts refuses such a launch. Under "ask" ADR 0001 §8 accepts that residual.
// - A child is dumpable again after its own execve, so it is not protected by this call. Rule 1's
//   scrubbed environment protects it instead.
// - Only Linux has PR_SET_DUMPABLE. On macOS a same-user process can read another process's startup
//   environment through KERN_PROCARGS2 and ps, and nothing equivalent exists. The call is a no-op
//   there and on Windows, and the guarantee is not claimed on those platforms.
// - A non-dumpable process writes no core dump.
import { dlopen, read } from "bun:ffi";
import { describeErrno, LIBC } from "./libc.ts";

// <linux/prctl.h>
const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;
// SUID_DUMP_DISABLE in <linux/sched/coredump.h>
const SUID_DUMP_DISABLE = 0;

export type MarkNonDumpableResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

// The C library calls this module makes. Tests pass a fake opener to reach each failure.
export interface Libc {
  readonly prctl: (
    option: number,
    arg2: number | bigint,
    arg3: number,
    arg4: number,
    arg5: number,
  ) => number;
  // The calling thread's errno. Read it right after the call that failed.
  readonly errno: () => number;
  readonly close: () => void;
}

// glibc declares prctl variadic. On x86-64 and arm64 Linux, integer variadic arguments travel in
// the same registers as fixed ones, so this fixed five-argument signature calls it correctly.
// glibc and musl both export __errno_location.
export function openLibc(): Libc {
  const library = dlopen(LIBC, {
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  });
  const { prctl, __errno_location } = library.symbols;
  return {
    prctl: (option, arg2, arg3, arg4, arg5) => prctl(option, arg2, arg3, arg4, arg5),
    errno: () => {
      const location = __errno_location();
      return location === null ? 0 : read.i32(location);
    },
    close: () => library.close(),
  };
}

const refuse = (message: string): MarkNonDumpableResult => ({ ok: false, message });

// Changes nothing on every platform except Linux. On Linux a failure is returned rather than
// ignored, because the caller must not start a child without the guarantee. The optional platform
// and opener are test seams; callers use the defaults.
export function markProcessNonDumpable(
  platform: NodeJS.Platform = process.platform,
  open: () => Libc = openLibc,
): MarkNonDumpableResult {
  if (platform !== "linux") return { ok: true };

  let libc: Libc;
  try {
    libc = open();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return refuse(`cannot load ${LIBC} to call prctl: ${reason}`);
  }
  try {
    if (libc.prctl(PR_SET_DUMPABLE, SUID_DUMP_DISABLE, 0, 0, 0) !== 0) {
      const reason = describeErrno(libc.errno());
      return refuse(`prctl(PR_SET_DUMPABLE, SUID_DUMP_DISABLE) failed: ${reason}`);
    }
    // Read the flag back, so a call that reports success but changes nothing still fails closed.
    const dumpable = libc.prctl(PR_GET_DUMPABLE, 0, 0, 0, 0);
    if (dumpable !== SUID_DUMP_DISABLE) {
      return refuse(`prctl(PR_GET_DUMPABLE) returned ${dumpable} after the flag was cleared`);
    }
    return { ok: true };
  } finally {
    libc.close();
  }
}
