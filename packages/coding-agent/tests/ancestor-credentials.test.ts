import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";
import {
  checkAncestorCredentials,
  credentialAssignment,
  heldCredential,
  type ProcFiles,
  parseStat,
  procFiles,
} from "../src/ancestor-credentials.ts";
import { runnerChainIsClean } from "./support/ancestor-chain.ts";
import {
  bunLikeShebang as bun,
  firstLine,
  runProcess,
  withTemporaryDirectory,
} from "./support/process.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });

const checkFailed = "cannot check the ancestor processes for a provider credential: ";

// A process table: each pid maps to its parent, its name, its environment and its arguments, or to
// the error code that reading a file throws.
interface FakeProcess {
  readonly parent: number;
  readonly name?: string;
  readonly environ?: string | { readonly error: string };
  readonly cmdline?: string | { readonly error: string };
  readonly statError?: string;
  // The start time of each stat read in turn, the last one repeating. A change models pid reuse.
  readonly starts?: readonly number[];
  // Every stat read after the first throws ENOENT, as for a process that exits during the walk.
  readonly exitsAfterFirstStat?: boolean;
}

function fakeProc(self: number, table: Record<number, FakeProcess>) {
  const read: string[] = [];
  const statReads = new Map<number, number>();
  const entry = (pid: number) => {
    const found = table[pid];
    if (found === undefined) throw errno("ENOENT");
    return found;
  };
  const text = (file: string | { readonly error: string }) => {
    if (typeof file !== "string") throw errno(file.error);
    return file;
  };
  const proc: ProcFiles = {
    stat: async (pid) => {
      read.push(`${pid}/stat`);
      const id = pid === "self" ? self : pid;
      const { parent, name = "sh", statError, starts = [100], exitsAfterFirstStat } = entry(id);
      if (statError !== undefined) throw errno(statError);
      const count = statReads.get(id) ?? 0;
      statReads.set(id, count + 1);
      if (exitsAfterFirstStat && count > 0) throw errno("ENOENT");
      const start = starts[Math.min(count, starts.length - 1)];
      return `${id} (${name}) S ${parent} ${id} ${id} 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 ${start}`;
    },
    environ: async (pid) => {
      read.push(`${pid}/environ`);
      return text(entry(pid).environ ?? "PATH=/usr/bin\0");
    },
    cmdline: async (pid) => {
      read.push(`${pid}/cmdline`);
      return text(entry(pid).cmdline ?? "sh\0");
    },
  };
  return { proc, read };
}

const linux = (proc: ProcFiles) => ({ platform: "linux" as const, proc });

// The stat fields after the name, up to the start time in field 22.
const statTail = "S 7 42 42 0 -1 4194560 100 0 0 0 0 0 0 0 20 0 1 0 555";

describe("parseStat", () => {
  it("reads the name, the parent and the start time, even when the name holds parentheses", () => {
    expect(parseStat(`42 (a b) c)) ${statTail}`)).toEqual({
      name: "a b) c)",
      parent: 7,
      start: "555",
    });
  });

  it.each(["", "42 sh S 7", "42 (sh) S", "42 (sh) S x", "42 (sh) S 7 42 42 0"])(
    "rejects %p",
    (text) => {
      expect(parseStat(text)).toBeUndefined();
    },
  );
});

describe("heldCredential", () => {
  const names = new Set(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

  it("names the first credential variable with a value", () => {
    expect(heldCredential("HOME=/root\0OPENAI_API_KEY=sk-1\0", names)).toBe("OPENAI_API_KEY");
  });

  it("counts a blank value as none, as the credential reader does", () => {
    expect(heldCredential("ANTHROPIC_API_KEY=  \0OPENAI_API_KEY=\0", names)).toBeUndefined();
  });

  it("ignores other variables, including names that only start like a credential", () => {
    expect(heldCredential("GH_TOKEN=x\0ANTHROPIC_API_KEY_FILE=/k\0", names)).toBeUndefined();
  });
});

describe("credentialAssignment", () => {
  const assignment = credentialAssignment(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

  it.each([
    "sh\0-c\0ANTHROPIC_API_KEY=sk-1 coding-agent run\0",
    "sh\0-c\0OPENAI_API_KEY='sk-1' exec coding-agent\0",
    'env\0ANTHROPIC_API_KEY="sk-1"\0bun\0',
  ])("finds the assignment in %p", (cmdline) => {
    expect(assignment.exec(cmdline)?.[1]).toBeDefined();
  });

  it.each([
    "sh\0-c\0ANTHROPIC_API_KEY= coding-agent\0",
    "sh\0-c\0ANTHROPIC_API_KEY='' coding-agent\0",
    "sh\0-c\0MY_ANTHROPIC_API_KEY=x ANTHROPIC_API_KEY_FILE=/k coding-agent\0",
  ])("ignores %p", (cmdline) => {
    expect(assignment.exec(cmdline)).toBeNull();
  });

  it("matches nothing without variables", () => {
    expect(credentialAssignment([]).exec("A=b")).toBeNull();
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
    expect(read).toEqual([
      "self/stat",
      ...["9/stat", "9/environ", "9/cmdline", "9/stat"],
      ...["1/stat", "1/environ", "1/cmdline", "1/stat"],
    ]);
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

  it("refuses when an ancestor assigns a credential in its arguments", async () => {
    const { proc } = fakeProc(10, {
      10: { parent: 9 },
      9: { parent: 0, cmdline: "sh\0-c\0ANTHROPIC_API_KEY=sk-test coding-agent run; cp out\0" },
    });
    const result = await checkAncestorCredentials("auto-approve", linux(proc));
    expect(result.ok ? undefined : result.message).toContain(" holds ANTHROPIC_API_KEY,");
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });

  it("shows the name as UTF-8 and escapes its control characters", async () => {
    // "café" as the latin1 decode of its UTF-8 bytes, which is how stat is read.
    const { proc } = fakeProc(10, {
      10: { parent: 9 },
      9: { parent: 0, name: "cafÃ©\n\u001b[2J", environ: credential },
    });
    const result = await checkAncestorCredentials("auto-approve", linux(proc));
    expect(result.ok ? undefined : result.message).toContain(" (café\\x0a\\x1b[2J) holds ");
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

  it("fails closed at an ancestor that is gone before its stat is read", async () => {
    const { proc } = fakeProc(10, {
      10: { parent: 9 },
      9: { parent: 5, statError: "ENOENT" },
      5: { parent: 0, environ: credential },
    });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: `${checkFailed}cannot read /proc/9/stat: ENOENT`,
    });
  });

  it.each([
    ["its environment is read", { parent: 5, environ: { error: "ESRCH" } }],
    ["its stat is read again", { parent: 5, exitsAfterFirstStat: true, environ: credential }],
  ] as const)("goes on to the parent of an ancestor that exits before %s", async (_, nine) => {
    const { proc } = fakeProc(10, {
      10: { parent: 9 },
      9: nine,
      5: { parent: 0, name: "bash", environ: credential },
    });
    const result = await checkAncestorCredentials("auto-approve", linux(proc));
    expect(result.ok ? undefined : result.message).toContain("ancestor process 5 (bash) holds");
  });

  it("does not blame an ancestor for the files of a process that reused its pid", async () => {
    const { proc, read } = fakeProc(10, {
      10: { parent: 9 },
      9: { parent: 0, starts: [100, 200], environ: credential },
    });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({ ok: true });
    expect(read.at(-1)).toBe("9/stat");
  });

  it("fails closed when /proc/self/stat cannot be read, for example without /proc", async () => {
    const { proc } = fakeProc(10, {});
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: `${checkFailed}cannot read /proc/self/stat: ENOENT`,
    });
  });

  it("fails closed when an ancestor's stat cannot be read for another reason", async () => {
    const { proc } = fakeProc(10, { 10: { parent: 9 }, 9: { parent: 0, statError: "EACCES" } });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: `${checkFailed}cannot read /proc/9/stat: EACCES`,
    });
  });

  it.each(["environ", "cmdline"] as const)(
    "fails closed when an ancestor's %s fails with an unexpected error",
    async (file) => {
      const { proc } = fakeProc(10, {
        10: { parent: 9 },
        9: { parent: 0, [file]: { error: "EIO" } },
      });
      expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
        ok: false,
        code: "CHECK_FAILED",
        message: `${checkFailed}cannot read /proc/9/${file}: EIO`,
      });
    },
  );

  it("fails closed on a stat it cannot parse", async () => {
    const proc: ProcFiles = {
      stat: async () => "garbage",
      environ: async () => "",
      cmdline: async () => "",
    };
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: `${checkFailed}cannot parse /proc/self/stat`,
    });
  });

  it("fails closed on a chain that never ends", async () => {
    const { proc } = fakeProc(10, { 10: { parent: 9 }, 9: { parent: 9 } });
    expect(await checkAncestorCredentials("auto-approve", linux(proc))).toEqual({
      ok: false,
      code: "CHECK_FAILED",
      message: `${checkFailed}the ancestor chain is longer than 4096 processes`,
    });
  });
});

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const failAncestorCheck = join(import.meta.dir, "support", "fail-ancestor-check.ts");
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

// fail-ancestor-check.ts replaces src/ancestor-credentials.ts in the child, so this runs on every
// platform.
describe("the coding-agent executable when the ancestor check cannot finish", () => {
  it("exits 70 with the message of the check and writes nothing", async () => {
    await withTemporaryDirectory(async (directory) => {
      const { exitCode, stdout, stderr } = await runProcess(
        [...bun, "--preload", failAncestorCheck, cli, ...parsedRun],
        { cwd: directory, env: credential },
      );

      expect(firstLine(stderr)).toBe("coding-agent: forced by the test");
      expect(exitCode).toBe(70);
      expect(stdout).toBe("");
      expect(await readdir(directory)).toEqual([]);
    });
  });
});

// The end-to-end part reads the real /proc, so it runs on Linux only: in CI on Ubuntu, and skipped
// elsewhere.
const onLinux = process.platform === "linux";

const cleanChain = await runnerChainIsClean();

// Each launcher is a shell that holds the credential and starts the Coding Agent. The first replaces
// itself with it. The second has a command after it, so the shell cannot exec and stays as the
// parent.
const execLauncher = ["/bin/sh", "-c", 'exec "$@"', "sh"];
const childLauncher = ["/bin/sh", "-c", '"$@"; exit $?', "sh"];

describe.skipIf(!onLinux)("the coding-agent executable on Linux under auto-approve", () => {
  it("reads the real parent from /proc/self/stat", async () => {
    expect(parseStat(await procFiles.stat("self"))?.parent).toBe(process.ppid);
  });

  // CI exports no provider key, so a skip of the tests below there can only mean that the check
  // wrongly refuses the runner's own chain.
  it.skipIf(!process.env.CI)("finds no credential above the CI runner", () => {
    expect(cleanChain).toBe(true);
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
