// A stand-in for the Linux capability rules that ptrace-capability.ts depends on, so its decisions
// can be tested on every platform. The rules are the ones read in security/commoncap.c: capset may
// only shrink the permitted set and keeps the effective set inside it, ambient capabilities follow
// permitted and inheritable, and PR_CAPBSET_DROP needs CAP_SETPCAP in the effective set.
import type { CapabilityLibc, CapabilitySets } from "../../src/ptrace-capability.ts";

// <linux/capability.h>
export const CAP_SETPCAP = 8n;
export const CAP_SYS_PTRACE = 19n;
export const bit = (capability: bigint): bigint => 1n << capability;

// <linux/prctl.h>
const PR_CAPBSET_READ = 23;
const PR_CAPBSET_DROP = 24;
const PR_CAP_AMBIENT = 47;
const PR_CAP_AMBIENT_IS_SET = 1;

const EPERM = 1;
const EINVAL = 22;

export interface KernelState extends CapabilitySets {
  readonly bounding: bigint;
  readonly ambient: bigint;
}

export interface KernelFaults {
  // capget fails with this errno.
  readonly capgetErrno?: number;
  // capset fails with this errno and changes nothing.
  readonly capsetErrno?: number;
  // PR_CAPBSET_READ fails with this errno.
  readonly capbsetReadErrno?: number;
  // PR_CAP_AMBIENT with PR_CAP_AMBIENT_IS_SET fails with this errno.
  readonly ambientReadErrno?: number;
  // PR_CAPBSET_DROP fails with this errno, whatever the caller holds.
  readonly bsetDropErrno?: number;
  // PR_CAPBSET_DROP and capset report success but change nothing.
  readonly ignoresChanges?: boolean;
}

export function fakeKernel(initial: KernelState, faults: KernelFaults = {}) {
  let state = { ...initial };
  let lastErrno = 0;
  let closed = false;
  const calls: string[] = [];

  const fail = (errno: number): number => {
    lastErrno = errno;
    return -1;
  };

  const open = (): CapabilityLibc => ({
    capget: () => {
      calls.push("capget");
      if (faults.capgetErrno !== undefined) {
        lastErrno = faults.capgetErrno;
        return null;
      }
      return {
        effective: state.effective,
        permitted: state.permitted,
        inheritable: state.inheritable,
      };
    },
    capset: (sets) => {
      calls.push("capset");
      if (faults.capsetErrno !== undefined) return fail(faults.capsetErrno);
      if (faults.ignoresChanges) return 0;
      const grows = (sets.permitted & ~state.permitted) !== 0n;
      const effectiveOutside = (sets.effective & ~sets.permitted) !== 0n;
      if (grows || effectiveOutside) return fail(EPERM);
      state = {
        ...state,
        effective: sets.effective,
        permitted: sets.permitted,
        inheritable: sets.inheritable,
        ambient: state.ambient & sets.permitted & sets.inheritable,
      };
      return 0;
    },
    prctl: (option, arg2, arg3) => {
      calls.push(`prctl:${option}:${arg2}`);
      if (option === PR_CAPBSET_READ) {
        if (faults.capbsetReadErrno !== undefined) return fail(faults.capbsetReadErrno);
        return (state.bounding & bit(BigInt(arg2))) !== 0n ? 1 : 0;
      }
      if (option === PR_CAPBSET_DROP) {
        if (faults.bsetDropErrno !== undefined) return fail(faults.bsetDropErrno);
        if ((state.effective & bit(CAP_SETPCAP)) === 0n) return fail(EPERM);
        if (faults.ignoresChanges) return 0;
        state = { ...state, bounding: state.bounding & ~bit(BigInt(arg2)) };
        return 0;
      }
      if (option === PR_CAP_AMBIENT && arg2 === PR_CAP_AMBIENT_IS_SET) {
        if (faults.ambientReadErrno !== undefined) return fail(faults.ambientReadErrno);
        return (state.ambient & bit(BigInt(arg3))) !== 0n ? 1 : 0;
      }
      return fail(EINVAL);
    },
    errno: () => lastErrno,
    close: () => {
      closed = true;
    },
  });

  return { open, state: () => state, calls, closed: () => closed };
}
