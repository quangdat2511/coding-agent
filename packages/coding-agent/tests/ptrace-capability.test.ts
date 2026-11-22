import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { type CapabilityLibc, dropPtraceCapability } from "../src/ptrace-capability.ts";
import { fakeKernel } from "./support/fake-kernel-capabilities.ts";
import { onLinux } from "./support/platform.ts";

// The capability sets of root in a Modal task sandbox, read from /proc/self/status by the CDA-121
// prototype on branch prototype/cda-121-drop-ptrace (commit c5b47c3, file
// prototype/cda-121/modal-run.log, variant "none"): bit 19 is in all five sets. The ADR 0001 §7
// amendment of CDA-121 holds the same numbers.
const modalRoot = {
  effective: 0xa80c05fbn,
  permitted: 0xa80c05fbn,
  inheritable: 0xa80405fbn,
  bounding: 0xa80c05fbn,
  ambient: 0xa80c05fbn,
};
// The same process after the drop, from the same log (variant "all"): only bit 19 is gone.
const modalRootAfter = {
  effective: 0xa80405fbn,
  permitted: 0xa80405fbn,
  inheritable: 0xa80405fbn,
  bounding: 0xa80405fbn,
  ambient: 0xa80405fbn,
};

describe("dropPtraceCapability", () => {
  it.each(["darwin", "win32"] as const)("changes nothing on %s", (platform) => {
    const open = (): CapabilityLibc => {
      throw new Error("the C library was opened");
    };
    expect(dropPtraceCapability(platform, open, { ruid: 0, euid: 0 })).toEqual({ ok: true });
  });

  it("removes the capability from all five sets of root on Modal", () => {
    const kernel = fakeKernel(modalRoot);
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 })).toEqual({ ok: true });
    expect(kernel.state()).toEqual(modalRootAfter);
    expect(kernel.closed()).toBe(true);
  });

  it("lowers the bounding set before it changes the other sets", () => {
    const kernel = fakeKernel(modalRoot);
    dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 });
    // capset needs CAP_SETPCAP in the effective set, which this module never clears, but the order
    // is part of what ADR 0001 §8 states, so a change to it must be deliberate.
    const bounding = kernel.calls.indexOf("prctl:24:19");
    const capset = kernel.calls.indexOf("capset");
    expect(bounding).toBeGreaterThanOrEqual(0);
    expect(bounding).toBeLessThan(capset);
  });

  it("fails closed when the C library cannot load", () => {
    const open = (): CapabilityLibc => {
      throw new Error("no such file");
    };
    expect(dropPtraceCapability("linux", open, { ruid: 0, euid: 0 })).toEqual({
      ok: false,
      code: "DROP_FAILED",
      message:
        "cannot drop CAP_SYS_PTRACE, so no child can be started safely: cannot load libc.so.6 to change capabilities: no such file",
    });
  });

  it("fails closed with the errno when capset fails", () => {
    const kernel = fakeKernel(modalRoot, { capsetErrno: 1 });
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 })).toEqual({
      ok: false,
      code: "DROP_FAILED",
      message:
        "cannot drop CAP_SYS_PTRACE, so no child can be started safely: capset failed: errno 1 (EPERM)",
    });
    expect(kernel.closed()).toBe(true);
  });

  it("fails closed with the errno when capget fails", () => {
    const kernel = fakeKernel(modalRoot, { capgetErrno: 22 });
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 })).toEqual({
      ok: false,
      code: "DROP_FAILED",
      message:
        "cannot drop CAP_SYS_PTRACE, so no child can be started safely: capget failed: errno 22 (EINVAL)",
    });
    expect(kernel.closed()).toBe(true);
  });

  it("refuses when a call reports success but the capability is still there", () => {
    const kernel = fakeKernel(modalRoot, { ignoresChanges: true });
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 })).toEqual({
      ok: false,
      code: "CAPABILITY_REMAINS",
      message:
        "CAP_SYS_PTRACE is still in the bounding set after the drop, so a Tool Call could read this process's credential; start Coding Agent without it, for example with docker run --cap-drop SYS_PTRACE",
    });
    expect(kernel.closed()).toBe(true);
  });

  it("lets an ordinary user run although the bounding set still holds the capability", () => {
    // An ordinary user on a Linux host: no effective or permitted capabilities, and the default
    // bounding set that holds every capability, bit 19 included. It cannot lower the bounding set.
    const kernel = fakeKernel({
      effective: 0n,
      permitted: 0n,
      inheritable: 0n,
      bounding: 0x1ffffffffffn,
      ambient: 0n,
    });
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 1000, euid: 1000 })).toEqual({
      ok: true,
    });
  });

  it("fails closed with the errno when lowering the bounding set fails for another reason", () => {
    const kernel = fakeKernel(modalRoot, { bsetDropErrno: 22 });
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 })).toEqual({
      ok: false,
      code: "DROP_FAILED",
      message:
        "cannot drop CAP_SYS_PTRACE, so no child can be started safely: prctl(PR_CAPBSET_DROP) failed: errno 22 (EINVAL)",
    });
    expect(kernel.closed()).toBe(true);
  });

  it("refuses root that cannot lower the bounding set", () => {
    // Root without CAP_SETPCAP (bit 8): its child would regain the capability at execve.
    const withoutSetpcap = modalRoot.effective & ~(1n << 8n);
    const kernel = fakeKernel({
      ...modalRoot,
      effective: withoutSetpcap,
      permitted: withoutSetpcap,
    });
    const result = dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 });
    expect(result).toMatchObject({ ok: false, code: "CAPABILITY_REMAINS" });
    expect(result.ok ? "" : result.message).toContain("the bounding set");
  });

  it("names the effective set when a capset that reported success changed nothing", () => {
    const kernel = fakeKernel(
      {
        effective: 1n << 19n,
        permitted: 1n << 19n,
        inheritable: 0n,
        bounding: 1n << 19n,
        ambient: 0n,
      },
      { ignoresChanges: true },
    );
    const result = dropPtraceCapability("linux", kernel.open, { ruid: 1000, euid: 1000 });
    expect(result).toMatchObject({ ok: false, code: "CAPABILITY_REMAINS" });
    expect(result.ok ? "" : result.message).toContain("the effective set");
  });
});

describe("dropPtraceCapability when the read-back cannot be trusted", () => {
  it("fails closed when reading the bounding set fails", () => {
    const kernel = fakeKernel(modalRoot, { capbsetReadErrno: 22 });
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 })).toEqual({
      ok: false,
      code: "DROP_FAILED",
      message:
        "cannot drop CAP_SYS_PTRACE, so no child can be started safely: prctl(PR_CAPBSET_READ) failed: errno 22 (EINVAL)",
    });
    expect(kernel.closed()).toBe(true);
  });

  it("fails closed when reading the ambient set fails for a reason other than a missing feature", () => {
    const kernel = fakeKernel(modalRoot, { ambientReadErrno: 1 });
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 })).toEqual({
      ok: false,
      code: "DROP_FAILED",
      message:
        "cannot drop CAP_SYS_PTRACE, so no child can be started safely: prctl(PR_CAP_AMBIENT) failed: errno 1 (EPERM)",
    });
  });

  it("treats EINVAL from the ambient read as a kernel without ambient capabilities", () => {
    // Linux before 4.3 has no ambient set, so nothing there can hold the capability.
    const kernel = fakeKernel(modalRoot, { ambientReadErrno: 22 });
    expect(dropPtraceCapability("linux", kernel.open, { ruid: 0, euid: 0 })).toEqual({ ok: true });
  });
});

// The real kernel, so a fake that disagrees with Linux cannot hide a wrong call. It runs wherever
// the tests run on Linux: as an ordinary user on CI, and as root with CAP_SYS_PTRACE in a container
// started with --cap-add=SYS_PTRACE, which is the Modal case. The drop is permanent for the test
// runner's thread, and it only removes a capability.
describe.skipIf(!onLinux)("dropPtraceCapability with the real C library", () => {
  it("leaves the thread without the capability in any set", () => {
    expect(dropPtraceCapability()).toEqual({ ok: true });

    // An independent read, through /proc, so a wrong capget or capset layout cannot agree with
    // itself. /proc/thread-self is this thread, the one that starts every child.
    const status = readFileSync("/proc/thread-self/status", "utf8");
    const mask = (name: string) => {
      const value = new RegExp(`^${name}:\\s*([0-9a-f]+)$`, "m").exec(status)?.[1];
      if (value === undefined) throw new Error(`${name} is missing from /proc/thread-self/status`);
      return BigInt(`0x${value}`);
    };
    const bit19 = 1n << 19n;
    expect(mask("CapEff") & bit19).toBe(0n);
    expect(mask("CapPrm") & bit19).toBe(0n);
    expect(mask("CapInh") & bit19).toBe(0n);
    expect(mask("CapAmb") & bit19).toBe(0n);
    // An ordinary user cannot lower the bounding set, and may keep the capability there.
    if (process.geteuid?.() === 0) expect(mask("CapBnd") & bit19).toBe(0n);
  });
});
