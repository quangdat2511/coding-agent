import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Libc, markProcessNonDumpable } from "../src/non-dumpable.ts";
import { firstLine, runProcess, withTemporaryDirectory } from "./support/process.ts";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const probe = join(import.meta.dir, "support", "proc-access-probe.ts");
const failHardening = join(import.meta.dir, "support", "fail-hardening.ts");

// The flags of the executable's shebang, so no bunfig.toml or .env of the host takes part. Bun
// 1.3.14 on Windows crashes on --config=/dev/null, so Windows runs without that flag.
const bun = [
  process.execPath,
  "--no-env-file",
  ...(process.platform === "win32" ? [] : ["--config=/dev/null"]),
];

const credentialName = "ANTHROPIC_API_KEY";
const credential = { [credentialName]: "sk-test-credential-value" };

// Arguments that parse, so cli.ts reaches the hardening. Without a task.md in the working
// directory, the run then stops with a configuration error.
const parsedRun = [
  "run",
  "--task-file",
  "task.md",
  "--provider",
  "anthropic",
  "--model",
  "claude-haiku-4-5",
  "--approval-policy",
  "auto-approve",
  "--output-dir",
  "out",
];

// <linux/prctl.h>
const PR_GET_DUMPABLE = 3;
const PR_SET_DUMPABLE = 4;

// A C library whose prctl returns `set` for PR_SET_DUMPABLE and `get` for PR_GET_DUMPABLE.
function fakeLibc(responses: { set: number; get: number; errno?: number }) {
  const calls: [number, number | bigint][] = [];
  let closed = false;
  const open = (): Libc => ({
    prctl: (option, arg2) => {
      calls.push([option, arg2]);
      return option === PR_SET_DUMPABLE ? responses.set : responses.get;
    },
    errno: () => responses.errno ?? 0,
    close: () => {
      closed = true;
    },
  });
  return { open, calls, closed: () => closed };
}

describe("markProcessNonDumpable", () => {
  it.each(["darwin", "win32"] as const)("changes nothing on %s", (platform) => {
    const open = (): Libc => {
      throw new Error("the C library was opened");
    };
    expect(markProcessNonDumpable(platform, open)).toEqual({ ok: true });
  });

  it("clears the flag on Linux and reads it back", () => {
    const libc = fakeLibc({ set: 0, get: 0 });
    expect(markProcessNonDumpable("linux", libc.open)).toEqual({ ok: true });
    expect(libc.calls).toEqual([
      [PR_SET_DUMPABLE, 0],
      [PR_GET_DUMPABLE, 0],
    ]);
    expect(libc.closed()).toBe(true);
  });

  it("fails closed when the C library cannot load", () => {
    const open = (): Libc => {
      throw new Error("no such file");
    };
    expect(markProcessNonDumpable("linux", open)).toEqual({
      ok: false,
      message: "cannot load libc.so.6 to call prctl: no such file",
    });
  });

  it("fails closed with the errno when prctl fails", () => {
    const libc = fakeLibc({ set: -1, get: 0, errno: 1 });
    expect(markProcessNonDumpable("linux", libc.open)).toEqual({
      ok: false,
      message: "prctl(PR_SET_DUMPABLE, SUID_DUMP_DISABLE) failed: errno 1 (EPERM)",
    });
    expect(libc.closed()).toBe(true);
  });

  it("fails closed when the flag does not read back as cleared", () => {
    const libc = fakeLibc({ set: 0, get: 1 });
    expect(markProcessNonDumpable("linux", libc.open)).toEqual({
      ok: false,
      message: "prctl(PR_GET_DUMPABLE) returned 1 after the flag was cleared",
    });
    expect(libc.closed()).toBe(true);
  });
});

// fail-hardening.ts replaces src/non-dumpable.ts in the child, so this runs on every platform.
describe("the coding-agent executable when the hardening fails", () => {
  it("exits 70 before it resolves the configuration", async () => {
    await withTemporaryDirectory(async (directory) => {
      await Bun.write(join(directory, "task.md"), "Add a failing test, then make it pass.\n");
      const { exitCode, stdout, stderr } = await runProcess(
        [...bun, "--preload", failHardening, cli, ...parsedRun],
        { cwd: directory, env: credential },
      );

      expect(firstLine(stderr)).toBe(
        "coding-agent: cannot mark the process non-dumpable, so no child can be started safely: forced by the test",
      );
      expect(exitCode).toBe(70);
      expect(stdout).toBe("");
      // A resolved configuration would have created the output directory.
      expect(await readdir(directory)).toEqual(["task.md"]);
    });
  });

  it("still exits 2 on a usage error, which is decided before the hardening", async () => {
    const { exitCode, stderr } = await runProcess([
      ...bun,
      "--preload",
      failHardening,
      cli,
      "run",
      "--nope",
    ]);

    expect(firstLine(stderr)).toBe('coding-agent: unknown flag "--nope"');
    expect(exitCode).toBe(2);
  });
});

interface ProcAccess {
  readonly environ: string;
  readonly environNames: readonly string[];
  readonly mem: string;
  readonly fd: string;
  readonly ptracerLifted: boolean;
}

// CapEff bits of CAP_SYS_PTRACE, CAP_SYS_ADMIN and CAP_PERFMON. A reader with CAP_SYS_PTRACE passes
// the check that non-dumpable adds, as ADR 0001 §8 states. A reader with CAP_SYS_ADMIN or
// CAP_PERFMON can still open environ, because mm_access falls back to perfmon_capable() for read
// access. So the guarantee cannot be shown when the tests run with any of them. Root without them,
// as in a default Docker container, still runs the test: read-proc.ts follows the fd links, which
// root cannot, instead of only listing them, which root can.
const bypassBits = [19n, 21n, 38n];

function holdsBypassCapability(): boolean {
  const capEff = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
  if (capEff === undefined) return false;
  const effective = BigInt(`0x${capEff}`);
  return bypassBits.some((bit) => (effective & (1n << bit)) !== 0n);
}

function yamaPtraceScope(): number | undefined {
  try {
    return Number(readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim());
  } catch {
    return undefined;
  }
}

// Yama denies attach-mode access, which /proc/<pid>/mem needs, with the same EACCES as a
// non-dumpable target. Only dumpability decides the mem result when Yama is absent, at scope 0, or
// at scope 1 once the probe lifted it. Scopes 2 and 3 deny every caller without CAP_SYS_PTRACE.
function memShowsDumpability(access: ProcAccess): boolean {
  const scope = yamaPtraceScope();
  return scope === undefined || scope === 0 || (scope === 1 && access.ptracerLifted);
}

const provable = process.platform === "linux" && !holdsBypassCapability();

// Runs the target in a temporary directory with a credential in its environment. The probe in the
// target starts a same-uid child against it as the target exits, and the child's report comes back.
// A missing or broken report fails with the target's exit code and stderr, which hold the cause.
function probeTarget(target: readonly string[]) {
  return withTemporaryDirectory(async (directory) => {
    const report = join(directory, "proc-access.json");
    const { exitCode, stderr } = await runProcess(target, {
      cwd: directory,
      env: { ...credential, PROC_ACCESS_REPORT: report },
    });
    const failed = (reason: string) =>
      new Error(`${reason}\nexit code: ${exitCode}\nstderr: ${stderr}`);
    const text = await readFile(report, "utf8").catch(() => {
      throw failed("the target wrote no proc access report");
    });
    try {
      return { exitCode, stderr, access: JSON.parse(text) as ProcAccess };
    } catch {
      throw failed(`the proc access report is not JSON: ${text}`);
    }
  });
}

describe.skipIf(!provable)("a same-uid child on Linux", () => {
  it("reads the environ, mem and fd links of a process that is not marked", async () => {
    const { exitCode, stderr, access } = await probeTarget([...bun, probe]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(access.environ).toBe("read");
    expect(access.environNames).toContain(credentialName);
    expect(access.fd).toBe("read");
    // The probe lifts Yama's scope 1. Scopes 2 and 3 deny attach-mode access to every caller
    // without CAP_SYS_PTRACE, so there the control cannot show a mem read.
    const scope = yamaPtraceScope();
    if (scope === undefined || scope <= 1) expect(access.mem).toBe("read");
  });

  it("cannot read the environ, mem or fd links of the Coding Agent process", async () => {
    const { exitCode, stderr, access } = await probeTarget([
      ...bun,
      "--preload",
      probe,
      cli,
      ...parsedRun,
    ]);

    expect(firstLine(stderr)).toBe('coding-agent: --task-file "task.md" does not exist');
    expect(exitCode).toBe(2);
    expect(access.environ).toBe("EACCES");
    expect(access.environNames).toEqual([]);
    expect(access.fd).toBe("EACCES");
    if (memShowsDumpability(access)) expect(access.mem).toBe("EACCES");
  });
});
