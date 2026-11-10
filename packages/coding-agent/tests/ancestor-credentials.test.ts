import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";
import {
  checkAncestorCredentials,
  heldCredential,
  type ProcFiles,
  parseStat,
  procFiles,
} from "../src/ancestor-credentials.ts";
import { firstLine, runProcess, withTemporaryDirectory } from "./support/process.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });

// A process table: each pid maps to its parent, its name, and its environment, or to the error
// code that reading the file throws.
interface FakeProcess {
  readonly parent: number;
  readonly name?: string;
  readonly environ?: string | { readonly error: string };
  readonly statError?: string;
}

function fakeProc(self: number, table: Record<number, FakeProcess>) {
  const read: string[] = [];
  const entry = (pid: number) => {
    const found = table[pid];
    if (found === undefined) throw errno("ENOENT");
    return found;
  };
  const proc: ProcFiles = {
    stat: async (pid) => {
      read.push(`${pid}/stat`);
      const id = pid === "self" ? self : pid;
      const { parent, name = "sh", statError } = entry(id);
      if (statError !== undefined) throw errno(statError);
      return `${id} (${name}) S ${parent} ${id} ${id} 0 -1 4194560 100 0 0 0`;
    },
    environ: async (pid) => {
      read.push(`${pid}/environ`);
      const { environ = "PATH=/usr/bin\0" } = entry(pid);
      if (typeof environ !== "string") throw errno(environ.error);
      return environ;
    },
  };
  return { proc, read };
}

const linux = (proc: ProcFiles) => ({ platform: "linux" as const, proc });

describe("parseStat", () => {
  it("reads the name and the parent, even when the name holds spaces and parentheses", () => {
    expect(parseStat("42 (a b) c)) S 7 42 42 0")).toEqual({ name: "a b) c)", parent: 7 });
  });

  it.each(["", "42 sh S 7", "42 (sh) S", "42 (sh) S x"])("rejects %p", (text) => {
    expect(parseStat(text)).toBeUndefined();
  });
});

describe("heldCredential", () => {
  const variables = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

  it("names the first credential variable with a value", () => {
    expect(heldCredential("HOME=/root\0OPENAI_API_KEY=sk-1\0", variables)).toBe("OPENAI_API_KEY");
  });

  it("counts a blank value as none, as the credential reader does", () => {
    expect(heldCredential("ANTHROPIC_API_KEY=  \0OPENAI_API_KEY=\0", variables)).toBeUndefined();
  });

  it("ignores other variables, including names that only start like a credential", () => {
    expect(heldCredential("GH_TOKEN=x\0ANTHROPIC_API_KEY_FILE=/k\0", variables)).toBeUndefined();
  });
});

describe("checkAncestorCredentials", () => {
  const credential = "ANTHROPIC_API_KEY=sk-test\0";

  it("does not run under ask, even on Linux", async () => {
    const { proc, read } = fakeProc(10, {
      10: { parent: 9 },
      9: { parent: 0, environ: credential },
    });
    expect(await checkAncestorCredentials("ask", linux(proc))).toEqual({ ok: true });
    expect(read).toEqual([]);
  });

  it.each(["darwin", "win32"] as const)("does not run on %s", async (platform) => {
    const { proc, read } = fakeProc(10, {
      10: { parent: 9 },
      9: { parent: 0, environ: credential },
    });
    expect(await checkAncestorCredentials("auto-approve", { platform, proc })).toEqual({
      ok: true,
    });
    expect(read).toEqual([]);
  });

  it("walks every ancestor from the parent to the end of the chain", async () => {
    const { proc, read } = fakeProc(10, { 10: { parent: 9 }, 9: { parent: 1 }, 1: { parent: 0 } });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({ ok: true });
    expect(read).toEqual(["self/stat", "9/stat", "9/environ", "1/stat", "1/environ"]);
  });

  it("does not read the environment of this process, which holds the credential by design", async () => {
    const { proc } = fakeProc(10, { 10: { parent: 0, environ: credential } });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({ ok: true });
  });

  it("refuses when an ancestor holds a credential, and names it without the value", async () => {
    const { proc } = fakeProc(10, {
      10: { parent: 9 },
      9: { parent: 5, name: "harbor-agent" },
      5: { parent: 0, name: "bash", environ: `HOME=/root\0${credential}` },
    });
    const result = await checkAncestorCredentials("auto-approve", linux(proc));
    expect(result).toEqual({
      ok: false,
      code: "CREDENTIAL_IN_ANCESTOR",
      message:
        "--approval-policy auto-approve refused: ancestor process 5 (bash) holds ANTHROPIC_API_KEY, " +
        "which a Tool Call could read; start Coding Agent with exec so that no process above it " +
        "keeps the credential",
    });
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("checks every credential variable that ai declares, not only the chosen provider's", async () => {
    for (const variable of PROVIDER_CREDENTIAL_ENV_VARS) {
      const { proc } = fakeProc(10, {
        10: { parent: 9 },
        9: { parent: 0, environ: `${variable}=k` },
      });
      const result = await checkAncestorCredentials("auto-approve", linux(proc));
      expect(result.ok ? undefined : result.message).toContain(` holds ${variable},`);
    }
  });

  it.each(["EACCES", "EPERM"])(
    "passes over an ancestor whose environment is denied with %s, and goes on to its parent",
    async (error) => {
      const { proc, read } = fakeProc(10, {
        10: { parent: 9 },
        9: { parent: 5, environ: { error } },
        5: { parent: 0, environ: credential },
      });
      const result = await checkAncestorCredentials("auto-approve", linux(proc));
      expect(result.ok ? undefined : result.code).toBe("CREDENTIAL_IN_ANCESTOR");
      expect(read).toContain("5/environ");
    },
  );

  it.each([
    ["stat", { parent: 5, statError: "ENOENT" }],
    ["environ", { parent: 5, environ: { error: "ESRCH" } }],
  ] as const)(
    "ends the chain at an ancestor that exited before its %s was read",
    async (_, nine) => {
      const { proc, read } = fakeProc(10, {
        10: { parent: 9 },
        9: nine,
        5: { parent: 0, environ: credential },
      });
      expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({ ok: true });
      expect(read).not.toContain("5/stat");
    },
  );

  it("fails closed when /proc/self/stat cannot be read, for example without /proc", async () => {
    const { proc } = fakeProc(10, {});
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: "cannot read /proc/self/stat: ENOENT",
    });
  });

  it("fails closed when an ancestor's stat cannot be read for another reason", async () => {
    const { proc } = fakeProc(10, { 10: { parent: 9 }, 9: { parent: 0, statError: "EACCES" } });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: "cannot read /proc/9/stat: EACCES",
    });
  });

  it("fails closed when an ancestor's environment fails with an unexpected error", async () => {
    const { proc } = fakeProc(10, {
      10: { parent: 9 },
      9: { parent: 0, environ: { error: "EIO" } },
    });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: "cannot read /proc/9/environ: EIO",
    });
  });

  it("fails closed on a stat it cannot parse", async () => {
    const proc: ProcFiles = { stat: async () => "garbage", environ: async () => "" };
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: "cannot parse /proc/self/stat",
    });
  });

  it("fails closed on a chain that never ends", async () => {
    const { proc } = fakeProc(10, { 10: { parent: 9 }, 9: { parent: 9 } });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: "the ancestor chain is longer than 4096 processes",
    });
  });
});

// The end-to-end part reads the real /proc, so it runs on Linux only: in CI on Ubuntu, and skipped
// elsewhere.
const onLinux = process.platform === "linux";

// The test runner is itself an ancestor of every Coding Agent it starts. If the shell that started
// it exported a provider key, every run is rightly refused, so the test of a clean launch cannot
// pass and is skipped. A .env file does not count: Bun loads it into process.env, which does not
// change /proc/self/environ.
async function runnerChainIsClean(): Promise<boolean> {
  if (!onLinux) return false;
  const own = heldCredential(readFileSync("/proc/self/environ", "latin1"), [
    ...PROVIDER_CREDENTIAL_ENV_VARS,
  ]);
  return own === undefined && (await checkAncestorCredentials("auto-approve")).ok;
}

const cleanChain = await runnerChainIsClean();

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const bun = [process.execPath, "--no-env-file", "--config=/dev/null"];
const credential = { ANTHROPIC_API_KEY: "sk-test-credential-value" };

// Arguments that parse. Without a task.md in the working directory, a run that passes the ancestor
// check stops at the task file instead.
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

// Each launcher is a shell that holds the credential and starts the Coding Agent. The first replaces
// itself with it. The second has a command after it, so the shell cannot exec and stays as the
// parent.
const execLauncher = ["/bin/sh", "-c", 'exec "$@"', "sh"];
const childLauncher = ["/bin/sh", "-c", '"$@"; exit $?', "sh"];

describe.skipIf(!onLinux)("the coding-agent executable on Linux under auto-approve", () => {
  it("reads the real parent from /proc/self/stat", async () => {
    expect(parseStat(await procFiles.stat("self"))?.parent).toBe(process.ppid);
  });

  it("refuses with exit 2 a launcher that stays alive with the credential", async () => {
    await withTemporaryDirectory(async (directory) => {
      const { exitCode, stdout, stderr } = await runProcess(
        [...childLauncher, ...bun, cli, ...parsedRun],
        {
          cwd: directory,
          env: credential,
        },
      );

      expect(firstLine(stderr)).toMatch(
        /^coding-agent: --approval-policy auto-approve refused: ancestor process \d+ \(sh\) holds ANTHROPIC_API_KEY, /,
      );
      expect(stderr).not.toContain(credential.ANTHROPIC_API_KEY);
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
      // The check comes before the configuration, so nothing was written.
      expect(await readdir(directory)).toEqual([]);
    });
  });

  it.skipIf(!cleanChain)("starts normally under a launcher that replaces itself", async () => {
    await withTemporaryDirectory(async (directory) => {
      const { exitCode, stderr } = await runProcess([...execLauncher, ...bun, cli, ...parsedRun], {
        cwd: directory,
        env: credential,
      });

      // Past the ancestor check, the run resolves its configuration and stops at the task file.
      expect(firstLine(stderr)).toBe('coding-agent: --task-file "task.md" does not exist');
      expect(exitCode).toBe(2);
    });
  });
});
