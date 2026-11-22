// ADR 0001 §8, CDA-121 amendment. Marking the process non-dumpable (non-dumpable.ts) does not stop a
// child that holds CAP_SYS_PTRACE: the kernel lets such a caller read a non-dumpable process of the
// same user. Root on Modal holds it, so a Tool Call child read the key there. Under "auto-approve"
// this module removes the capability from the thread that starts every child, so a child never
// receives it. cli.ts calls dropPtraceCapability right after markProcessNonDumpable, on the
// `run` path only, and ahead of every child.
//
// Limits of the guarantee (see also the package README):
// - Only the calling thread changes, because capabilities belong to a thread. Bun.spawn runs vfork
//   and execve on the thread that calls it, which is the JavaScript thread, so every child starts
//   from the dropped set. Bun's own helper threads keep the capability. They start no child, and a
//   reader that holds less than a target's permitted set is refused, so they are harder to read
//   than the dropped thread, not easier (security/commoncap.c, cap_ptrace_access_check).
// - The bounding set matters only to root. At execve, root's child gets permitted = bounding |
//   inheritable, so the capability would come back. An ordinary user's child gets no capability from
//   the bounding set, and a user that cannot lower it, which needs CAP_SETPCAP, is allowed to run.
//   Such a child can still regain the capability by running a setuid-root program or a file with
//   file capabilities. This module does not set PR_SET_NO_NEW_PRIVS, because that would break sudo
//   for every Tool Call.
// - It does nothing on macOS and Windows, which have no capability sets.
import { dlopen, ptr, read } from "bun:ffi";
import { constants } from "node:os";

// glibc's soname; musl's loader answers any "libc." name with itself, as in non-dumpable.ts.
const LIBC = "libc.so.6";

// <linux/capability.h>
const CAP_SYS_PTRACE = 19;
const PTRACE_BIT = 1n << BigInt(CAP_SYS_PTRACE);
// Version 3 carries two 32-bit words per set. A header pid of 0 means the calling thread.
const LINUX_CAPABILITY_VERSION_3 = 0x20080522;

// <linux/prctl.h>
const PR_CAPBSET_READ = 23;
const PR_CAPBSET_DROP = 24;
const PR_CAP_AMBIENT = 47;
const PR_CAP_AMBIENT_IS_SET = 1;

// <asm-generic/errno-base.h>
const EPERM = 1;
const EINVAL = 22;

const LOW_WORD = 0xffffffffn;

// The three sets that capget and capset carry, as 64-bit masks.
export interface CapabilitySets {
  readonly effective: bigint;
  readonly permitted: bigint;
  readonly inheritable: bigint;
}

// The C library calls this module makes, on the calling thread. Tests pass a fake kernel.
export interface CapabilityLibc {
  // capget for the calling thread; null on failure, and errno says why.
  readonly capget: () => CapabilitySets | null;
  // capset for the calling thread; 0 on success.
  readonly capset: (sets: CapabilitySets) => number;
  readonly prctl: (
    option: number,
    arg2: number,
    arg3: number,
    arg4: number,
    arg5: number,
  ) => number;
  readonly errno: () => number;
  readonly close: () => void;
}

export interface ProcessIds {
  readonly ruid: number;
  readonly euid: number;
}

// The capability sets that the message can name, in the order that it checks them.
type CapabilitySet = "bounding" | "effective" | "permitted" | "inheritable" | "ambient";

// The message of a failure is the whole diagnostic, so cli.ts only chooses the exit code.
export type DropPtraceResult =
  | { readonly ok: true }
  // The capability is still held after the drop: a launcher problem, exit 2.
  | { readonly ok: false; readonly code: "CAPABILITY_REMAINS"; readonly message: string }
  // A call failed, so nothing is shown about the capability: exit 70.
  | { readonly ok: false; readonly code: "DROP_FAILED"; readonly message: string };

type DropFailure = Extract<DropPtraceResult, { readonly code: "DROP_FAILED" }>;

const dropFailed = (cause: string): DropFailure => ({
  ok: false,
  code: "DROP_FAILED",
  message: `cannot drop CAP_SYS_PTRACE, so no child can be started safely: ${cause}`,
});

// Same wording as non-dumpable.ts, kept here so that this module does not import it: a test
// preload replaces that file.
function describeErrno(code: number): string {
  const name = Object.entries(constants.errno).find(([, value]) => value === code)?.[0];
  return name === undefined ? `errno ${code}` : `errno ${code} (${name})`;
}

const joinWords = (low: number, high: number): bigint => BigInt(low) | (BigInt(high) << 32n);

// glibc declares prctl variadic. On x86-64 and arm64 Linux, integer variadic arguments travel in the
// same registers as fixed ones, so this fixed five-argument signature calls it correctly.
// capget and capset take a header and an array of two {effective, permitted, inheritable} words.
export function openCapabilityLibc(): CapabilityLibc {
  const library = dlopen(LIBC, {
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    capget: { args: ["ptr", "ptr"], returns: "i32" },
    capset: { args: ["ptr", "ptr"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  });
  const { prctl, capget, capset, __errno_location } = library.symbols;
  // The arrays are locals of the call that reads them, so nothing can free them while C does.
  const readSets = (header: Uint32Array, data: Uint32Array): number =>
    capget(ptr(header), ptr(data));
  return {
    capget: () => {
      const header = new Uint32Array([LINUX_CAPABILITY_VERSION_3, 0]);
      const data = new Uint32Array(6);
      if (readSets(header, data) !== 0) return null;
      return {
        effective: joinWords(data[0] ?? 0, data[3] ?? 0),
        permitted: joinWords(data[1] ?? 0, data[4] ?? 0),
        inheritable: joinWords(data[2] ?? 0, data[5] ?? 0),
      };
    },
    capset: (sets) => {
      // This module changes only bit 19, in the low word, but capset takes both words, so read the
      // current ones first.
      const header = new Uint32Array([LINUX_CAPABILITY_VERSION_3, 0]);
      const data = new Uint32Array(6);
      if (readSets(header, data) !== 0) return -1;
      data[0] = Number(sets.effective & LOW_WORD);
      data[1] = Number(sets.permitted & LOW_WORD);
      data[2] = Number(sets.inheritable & LOW_WORD);
      data[3] = Number(sets.effective >> 32n);
      data[4] = Number(sets.permitted >> 32n);
      data[5] = Number(sets.inheritable >> 32n);
      return capset(ptr(header), ptr(data));
    },
    prctl: (option, arg2, arg3, arg4, arg5) => prctl(option, arg2, arg3, arg4, arg5),
    errno: () => {
      const location = __errno_location();
      return location === null ? 0 : read.i32(location);
    },
    close: () => library.close(),
  };
}

// Whether the bounding set holds the capability. A result other than 0 or 1 is a failed call.
function boundingHolds(libc: CapabilityLibc): boolean | DropFailure {
  const held = libc.prctl(PR_CAPBSET_READ, CAP_SYS_PTRACE, 0, 0, 0);
  if (held === 0 || held === 1) return held === 1;
  return dropFailed(`prctl(PR_CAPBSET_READ) failed: ${describeErrno(libc.errno())}`);
}

// Whether the ambient set holds the capability. EINVAL means a kernel before 4.3, which has no
// ambient set, so nothing is held there.
function ambientHolds(libc: CapabilityLibc): boolean | DropFailure {
  const held = libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, CAP_SYS_PTRACE, 0, 0);
  if (held === 0 || held === 1) return held === 1;
  if (libc.errno() === EINVAL) return false;
  return dropFailed(`prctl(PR_CAP_AMBIENT) failed: ${describeErrno(libc.errno())}`);
}

// The first set that still holds the capability, in the order that the message names them, or the
// failure of a read.
function firstSetHolding(
  libc: CapabilityLibc,
  sets: CapabilitySets,
  ids: ProcessIds,
): CapabilitySet | undefined | DropFailure {
  // A child of root regains the bounding set at execve, so root must not hold it there.
  const isRoot = ids.ruid === 0 || ids.euid === 0;
  if (isRoot) {
    const bounding = boundingHolds(libc);
    if (typeof bounding !== "boolean") return bounding;
    if (bounding) return "bounding";
  }
  if ((sets.effective & PTRACE_BIT) !== 0n) return "effective";
  if ((sets.permitted & PTRACE_BIT) !== 0n) return "permitted";
  if ((sets.inheritable & PTRACE_BIT) !== 0n) return "inheritable";
  const ambient = ambientHolds(libc);
  if (typeof ambient !== "boolean") return ambient;
  return ambient ? "ambient" : undefined;
}

// Removes CAP_SYS_PTRACE from the calling thread, then reads every set back. Changes nothing off
// Linux. A failure is returned, not ignored, because the caller must not start a child without the
// guarantee. The optional platform, opener and ids are test seams; callers use the defaults.
export function dropPtraceCapability(
  platform: NodeJS.Platform = process.platform,
  open: () => CapabilityLibc = openCapabilityLibc,
  ids: ProcessIds = { ruid: process.getuid?.() ?? -1, euid: process.geteuid?.() ?? -1 },
): DropPtraceResult {
  if (platform !== "linux") return { ok: true };
  let libc: CapabilityLibc;
  try {
    libc = open();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return dropFailed(`cannot load ${LIBC} to change capabilities: ${reason}`);
  }
  try {
    const bounding = boundingHolds(libc);
    if (typeof bounding !== "boolean") return bounding;
    // EPERM means the caller lacks CAP_SETPCAP. The read-back below decides whether that matters.
    if (
      bounding &&
      libc.prctl(PR_CAPBSET_DROP, CAP_SYS_PTRACE, 0, 0, 0) !== 0 &&
      libc.errno() !== EPERM
    ) {
      return dropFailed(`prctl(PR_CAPBSET_DROP) failed: ${describeErrno(libc.errno())}`);
    }
    const sets = libc.capget();
    if (sets === null) return dropFailed(`capget failed: ${describeErrno(libc.errno())}`);
    // Skip capset when nothing holds the capability: a sandbox can deny the call by seccomp, and an
    // ordinary user with nothing to drop must still run.
    if (((sets.effective | sets.permitted | sets.inheritable) & PTRACE_BIT) !== 0n) {
      const cleared = {
        effective: sets.effective & ~PTRACE_BIT,
        permitted: sets.permitted & ~PTRACE_BIT,
        inheritable: sets.inheritable & ~PTRACE_BIT,
      };
      if (libc.capset(cleared) !== 0) {
        return dropFailed(`capset failed: ${describeErrno(libc.errno())}`);
      }
    }

    // Read every set back, so a call that reports success but changes nothing still fails closed.
    const after = libc.capget();
    if (after === null) return dropFailed(`capget failed: ${describeErrno(libc.errno())}`);
    const remaining = firstSetHolding(libc, after, ids);
    if (typeof remaining === "object") return remaining;
    if (remaining !== undefined) {
      return {
        ok: false,
        code: "CAPABILITY_REMAINS",
        message: `CAP_SYS_PTRACE is still in the ${remaining} set after the drop, so a Tool Call could read this process's credential; start Coding Agent without it, for example with docker run --cap-drop SYS_PTRACE`,
      };
    }
    return { ok: true };
  } finally {
    libc.close();
  }
}
