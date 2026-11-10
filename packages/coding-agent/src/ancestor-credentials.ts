// ADR 0001 §8, startup verification under "auto-approve". Rules 1 and 2 keep the credential away
// from a Tool Call child through this process. A launcher that started Coding Agent as a child,
// rather than replacing itself with it through exec, still holds the credential in its own
// /proc/<pid>/environ, and a same-uid child can read that file. Coding Agent cannot scrub or mark
// a process it did not start. So before an Agent Session opens under "auto-approve", cli.ts walks
// the ancestor chain from this process's parent and refuses the run if an ancestor still holds one
// of the provider-credential variables, in its environment or as an assignment in its arguments.
//
// Limits of the check (see also the package README):
// - It runs only under "auto-approve". Under "ask", ADR 0001 §8 accepts the residual: the read path
//   jail keeps read out of /proc, and every mutating bash waits for an Approval.
// - It runs only on Linux. Other platforms have no /proc/<pid>/environ to read, and no
//   non-dumpable control that would make the check meaningful.
// - It walks only the ancestor chain. A credential-bearing sibling, such as another stage of a
//   pipeline, stays the launcher's responsibility under the launch contract.
// - It sees only the environment that each ancestor received from execve, and its arguments. An
//   ancestor that set the variable itself after it started, such as a shell that ran `export`,
//   keeps it only in its memory, which this check cannot read.
// - It reads each environment as this process can. A Tool Call child runs with the same user and
//   capabilities, so an ancestor whose environment this process cannot read, such as a root-owned
//   init or another non-dumpable process, is also out of the child's reach and is passed over.
import { readFile } from "node:fs/promises";
import type { ApprovalPolicy } from "@coding-agent/agent-core";
import { PROVIDER_CREDENTIAL_ENV_VARS, readEnvCredential } from "@coding-agent/ai";
import { errnoOf } from "@coding-agent/tools";

export type AncestorCheckResult =
  | { readonly ok: true }
  // An ancestor holds a credential: a configuration error, exit 2.
  | { readonly ok: false; readonly code: "CREDENTIAL_IN_ANCESTOR"; readonly message: string }
  // The walk could not finish, so the absence of a credential is not shown: exit 70.
  | { readonly ok: false; readonly code: "CHECK_FAILED"; readonly message: string };

type Failure = Extract<AncestorCheckResult, { readonly code: "CHECK_FAILED" }>;

// The /proc files the walk reads. Tests pass a fake to reach each branch on every platform.
export interface ProcFiles {
  readonly stat: (pid: number | "self") => Promise<string>;
  readonly environ: (pid: number) => Promise<string>;
  readonly cmdline: (pid: number) => Promise<string>;
}

// latin1 maps every byte of stat to one character, so a name that is not UTF-8 cannot shift the
// fields. environ and cmdline are decoded as UTF-8, as Bun decodes process.env, so a value is blank
// here exactly when readEnvCredential would find it blank in this process.
export const procFiles: ProcFiles = {
  stat: (pid) => readFile(`/proc/${pid}/stat`, "latin1"),
  environ: (pid) => readFile(`/proc/${pid}/environ`, "utf8"),
  cmdline: (pid) => readFile(`/proc/${pid}/cmdline`, "utf8"),
};

export interface AncestorCheckOptions {
  readonly platform?: NodeJS.Platform;
  readonly proc?: ProcFiles;
  readonly variables?: readonly string[];
}

// A chain longer than this is not a real process tree, so the walk stops and fails closed.
const MAX_ANCESTORS = 4096;

interface Stat {
  readonly name: string;
  readonly parent: number;
  // Field 22, the start time in clock ticks after boot. With the pid, it names one process.
  readonly start: string;
}

// /proc/<pid>/stat is "pid (comm) state ppid ...". comm can hold spaces and parentheses, so the
// fields after it start at the last ")".
export function parseStat(text: string): Stat | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close < open) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const parent = Number(fields[1]);
  const start = fields[19];
  if (!Number.isSafeInteger(parent) || parent < 0) return undefined;
  if (start === undefined || !/^\d+$/.test(start)) return undefined;
  return { name: text.slice(open + 1, close), parent, start };
}

// The first credential variable that `environ` sets to a value that is not blank, by the rule of
// readEnvCredential.
export function heldCredential(environ: string, names: ReadonlySet<string>): string | undefined {
  for (const entry of environ.split("\0")) {
    const equals = entry.indexOf("=");
    if (equals === -1) continue;
    const name = entry.slice(0, equals);
    if (!names.has(name)) continue;
    const found = readEnvCredential([name], { [name]: entry.slice(equals + 1) });
    if (found !== undefined) return found.variable;
  }
  return undefined;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches an assignment of a value that is not blank to one of `variables` in a command line, as in
// sh -c 'ANTHROPIC_API_KEY=sk-... coding-agent run ...'. Group 1 is the variable. /proc/<pid>/cmdline
// is readable by every process, so such a launcher exposes the credential whatever its environment.
export function credentialAssignment(variables: readonly string[]): RegExp {
  if (variables.length === 0) return /(?!)/;
  const names = variables.map(escapeRegExp).join("|");
  return new RegExp(`(?<!\\w)(${names})=["']?[^\\s"'\\0]`);
}

// The name as UTF-8, with control characters escaped, so that a launcher cannot put a line break or
// a terminal escape into the message.
function printable(latin1: string): string {
  return Buffer.from(latin1, "latin1")
    .toString("utf8")
    .replace(/\p{Cc}/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

const failed = (message: string): Failure => ({
  ok: false,
  code: "CHECK_FAILED",
  message: `cannot check the ancestor processes for a provider credential: ${message}`,
});

const isFailure = (value: object | string): value is Failure =>
  typeof value === "object" && "ok" in value;

const reason = (error: unknown): string =>
  errnoOf(error) ?? (error instanceof Error ? error.message : String(error));

const exited = (error: unknown) => errnoOf(error) === "ENOENT" || errnoOf(error) === "ESRCH";

// The stat of `pid`. A process that is gone is a failure, unless `whenGone` asks to report it.
function readStat(proc: ProcFiles, pid: number | "self", whenGone: "fail"): Promise<Stat | Failure>;
function readStat(
  proc: ProcFiles,
  pid: number,
  whenGone: "report",
): Promise<Stat | Failure | "gone">;
async function readStat(
  proc: ProcFiles,
  pid: number | "self",
  whenGone: "fail" | "report",
): Promise<Stat | Failure | "gone"> {
  let text: string;
  try {
    text = await proc.stat(pid);
  } catch (error) {
    if (whenGone === "report" && exited(error)) return "gone";
    return failed(`cannot read /proc/${pid}/stat: ${reason(error)}`);
  }
  return parseStat(text) ?? failed(`cannot parse /proc/${pid}/stat`);
}

// The text of an environ or cmdline file. It is empty when the process is gone, and when the file
// is denied with EACCES or EPERM: a same-uid child is denied it too, so the credential, if any, is
// out of the child's reach.
async function readOrEmpty(read: () => Promise<string>, path: string): Promise<string | Failure> {
  try {
    return await read();
  } catch (error) {
    const code = errnoOf(error);
    if (exited(error) || code === "EACCES" || code === "EPERM") return "";
    return failed(`cannot read ${path}: ${reason(error)}`);
  }
}

// Every outcome except "no ancestor holds a credential" refuses the run, so a walk that cannot
// finish fails closed. The optional platform, files and variables are test seams; callers use the
// defaults.
export async function checkAncestorCredentials(
  approvalPolicy: ApprovalPolicy,
  {
    platform = process.platform,
    proc = procFiles,
    variables = PROVIDER_CREDENTIAL_ENV_VARS,
  }: AncestorCheckOptions = {},
): Promise<AncestorCheckResult> {
  if (approvalPolicy !== "auto-approve" || platform !== "linux") return { ok: true };

  const self = await readStat(proc, "self", "fail");
  if (isFailure(self)) return self;
  const names = new Set(variables);
  const assignment = credentialAssignment(variables);

  // Parent 0 ends the chain: it is the parent of init and of every kernel thread.
  for (let pid = self.parent, steps = 0; pid !== 0; steps++) {
    if (steps === MAX_ANCESTORS) {
      return failed(`the ancestor chain is longer than ${MAX_ANCESTORS} processes`);
    }
    // An ancestor that is gone, or that hidepid hides, fails the walk: the processes above it can
    // still hold the credential, and a walk from here can no longer find them.
    const stat = await readStat(proc, pid, "fail");
    if (isFailure(stat)) return stat;

    const environ = await readOrEmpty(() => proc.environ(pid), `/proc/${pid}/environ`);
    if (isFailure(environ)) return environ;
    const cmdline = await readOrEmpty(() => proc.cmdline(pid), `/proc/${pid}/cmdline`);
    if (isFailure(cmdline)) return cmdline;
    const variable = heldCredential(environ, names) ?? assignment.exec(cmdline)?.[1];

    // Read the stat again. If the pid now names another process, or none, the process read above
    // has exited and holds nothing now, and the files may belong to a process that reused the pid.
    // The walk then goes on from the parent it had.
    const again = await readStat(proc, pid, "report");
    if (isFailure(again)) return again;
    const same = again !== "gone" && again.start === stat.start;
    if (same && variable !== undefined) {
      return {
        ok: false,
        code: "CREDENTIAL_IN_ANCESTOR",
        message:
          `--approval-policy auto-approve refused: ancestor process ${pid} ` +
          `(${printable(stat.name)}) holds ${variable}, which a Tool Call could read; start ` +
          "Coding Agent with exec so that no process above it keeps the credential",
      };
    }
    pid = same ? again.parent : stat.parent;
  }
  return { ok: true };
}
