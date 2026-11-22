import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerChainIsClean } from "./support/ancestor-chain.ts";
import { parsedRun } from "./support/parsed-run.ts";
import { onLinux } from "./support/platform.ts";
import { bunLikeShebang as bun, runProcess, withTemporaryDirectory } from "./support/process.ts";

// The Modal case on a local machine: root that holds CAP_SYS_PTRACE (bit 19 of CapEff). Start the
// tests in a container with `docker run --cap-add=SYS_PTRACE`, as root. CI runs as an ordinary user,
// so this file is skipped there; the C library calls are tested in ptrace-capability.test.ts.
function holdsPtraceAsRoot(): boolean {
  if (!onLinux || process.getuid?.() !== 0) return false;
  const capEff = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync("/proc/self/status", "utf8"))?.[1];
  return capEff !== undefined && (BigInt(`0x${capEff}`) & (1n << 19n)) !== 0n;
}

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const probe = join(import.meta.dir, "support", "proc-access-probe.ts");
const markOnly = join(import.meta.dir, "support", "mark-only.ts");

const credentialName = "ANTHROPIC_API_KEY";
const credential = { [credentialName]: "sk-test-credential-value" };

interface ProcAccess {
  readonly environ: string;
  readonly environNames: readonly string[];
  readonly mem: string;
  readonly fd: string;
}

// Runs the target with a credential in its environment. The probe in the target starts a same-uid
// child against it as the target exits, and the child's report comes back.
function probeTarget(target: readonly string[]) {
  return withTemporaryDirectory(async (directory) => {
    const report = join(directory, "proc-access.json");
    const { exitCode, stderr } = await runProcess(target, {
      cwd: directory,
      env: { ...credential, PROC_ACCESS_REPORT: report },
    });
    const text = await readFile(report, "utf8").catch(() => {
      throw new Error(`the target wrote no proc access report\nexit code: ${exitCode}\n${stderr}`);
    });
    return { exitCode, access: JSON.parse(text) as ProcAccess };
  });
}

const cleanChain = await runnerChainIsClean();

describe.skipIf(!holdsPtraceAsRoot())("a root child that holds CAP_SYS_PTRACE", () => {
  it("reads a non-dumpable process: the leak that CDA-94 found on Modal", async () => {
    const { access } = await probeTarget([...bun, "--preload", probe, markOnly]);

    expect(access.environ).toBe("read");
    expect(access.environNames).toContain(credentialName);
    expect(access.mem).toBe("read");
    expect(access.fd).toBe("read");
  });

  it.skipIf(!cleanChain)(
    "cannot read the Coding Agent process after it drops the capability",
    async () => {
      const { exitCode, access } = await probeTarget([
        ...bun,
        "--preload",
        probe,
        cli,
        ...parsedRun,
      ]);

      // No task.md, so the run stops with a configuration error after the drop.
      expect(exitCode).toBe(2);
      expect(access.environ).toBe("EACCES");
      expect(access.environNames).toEqual([]);
      expect(access.mem).toBe("EACCES");
      expect(access.fd).toBe("EACCES");
    },
  );
});
