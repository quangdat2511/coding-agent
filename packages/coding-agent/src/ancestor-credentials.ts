// ADR 0001 §8, startup verification under "auto-approve". Rules 1 and 2 keep the credential away
// from a Tool Call child through this process. A launcher that started Coding Agent as a child,
// rather than replacing itself with it through exec, still holds the credential in its own
// /proc/<pid>/environ, and a same-uid child can read that file. Coding Agent cannot scrub or mark
// a process it did not start. So before an Agent Session opens under "auto-approve", cli.ts walks
// the ancestor chain from this process's parent and refuses the run if an ancestor still holds one
// of the provider-credential variables.
//
// Limits of the check (see also the package README):
// - It runs only under "auto-approve". Under "ask", ADR 0001 §8 accepts the residual: the read path
//   jail keeps read out of /proc, and every mutating bash waits for an Approval.
// - It runs only on Linux. Other platforms have no /proc/<pid>/environ to read, and no
//   non-dumpable control that would make the check meaningful.
// - It walks only the ancestor chain. A credential-bearing sibling, such as another stage of a
//   pipeline, stays the launcher's responsibility under the launch contract.
// - It reads each environment as this process can. A Tool Call child runs with the same user and
//   capabilities, so an ancestor whose environment this process cannot read, such as a root-owned
//   init or another non-dumpable process, is also out of the child's reach and is passed over.
import { readFile } from "node:fs/promises";
import type { ApprovalPolicy } from "@coding-agent/agent-core";
import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";
import { errnoOf } from "@coding-agent/tools";

export type AncestorCheckResult =
  | { readonly ok: true }
  // An ancestor holds a credential: a configuration error, exit 2.
  | { readonly ok: false; readonly code: "CREDENTIAL_IN_ANCESTOR"; readonly message: string }
  // The walk could not finish, so the absence of a credential is not shown: exit 70.
  | { readonly ok: false; readonly code: "CHECK_FAILED"; readonly message: string };

// The two /proc files the walk reads. Tests pass a fake to reach each branch on every platform.
export interface ProcFiles {
  readonly stat: (pid: number | "self") => Promise<string>;
  readonly environ: (pid: number) => Promise<string>;
}

// The variable names are ASCII, and latin1 maps every byte of a value to one character, so a value
// that is not UTF-8 cannot make the decode fail.
export const procFiles: ProcFiles = {
  stat: (pid) => readFile(`/proc/${pid}/stat`, "latin1"),
  environ: (pid) => readFile(`/proc/${pid}/environ`, "latin1"),
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
}

// /proc/<pid>/stat is "pid (comm) state ppid ...". comm can hold spaces and parentheses, so the
// fields after it start at the last ")".
export function parseStat(text: string): Stat | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open === -1 || close < open) return undefined;
  const parent = Number(
    text
      .slice(close + 1)
      .trim()
      .split(/\s+/)[1],
  );
  if (!Number.isSafeInteger(parent) || parent < 0) return undefined;
  return { name: text.slice(open + 1, close), parent };
}

// The first credential variable that `environ` sets to a value that is not blank, which is the rule
// readEnvCredential applies to this process's own environment.
export function heldCredential(environ: string, variables: readonly string[]): string | undefined {
  const names = new Set(variables);
  for (const entry of environ.split("\0")) {
    const equals = entry.indexOf("=");
    if (equals === -1) continue;
    const name = entry.slice(0, equals);
    if (names.has(name) && entry.slice(equals + 1).trim() !== "") return name;
  }
  return undefined;
}

const failed = (message: string): AncestorCheckResult => ({
  ok: false,
  code: "CHECK_FAILED",
  message,
});

const reason = (error: unknown): string =>
  errnoOf(error) ?? (error instanceof Error ? error.message : String(error));

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

  let self: Stat | undefined;
  try {
    self = parseStat(await proc.stat("self"));
  } catch (error) {
    return failed(`cannot read /proc/self/stat: ${reason(error)}`);
  }
  if (self === undefined) return failed("cannot parse /proc/self/stat");

  // Parent 0 ends the chain: it is the parent of init and of every kernel thread.
  for (let pid = self.parent, steps = 0; pid !== 0; steps++) {
    if (steps === MAX_ANCESTORS) {
      return failed(`the ancestor chain is longer than ${MAX_ANCESTORS} processes`);
    }
    let stat: Stat | undefined;
    try {
      stat = parseStat(await proc.stat(pid));
    } catch (error) {
      // The ancestor exited during the walk. It holds nothing now, and its children moved to a
      // new parent that a walk from here cannot reach, so the chain ends.
      if (errnoOf(error) === "ENOENT" || errnoOf(error) === "ESRCH") break;
      return failed(`cannot read /proc/${pid}/stat: ${reason(error)}`);
    }
    if (stat === undefined) return failed(`cannot parse /proc/${pid}/stat`);

    let environ: string | undefined;
    try {
      environ = await proc.environ(pid);
    } catch (error) {
      const code = errnoOf(error);
      if (code === "ENOENT" || code === "ESRCH") break;
      // A same-uid child is denied this file too, so the credential, if any, is out of its reach.
      if (code !== "EACCES" && code !== "EPERM") {
        return failed(`cannot read /proc/${pid}/environ: ${reason(error)}`);
      }
    }
    const variable = environ === undefined ? undefined : heldCredential(environ, variables);
    if (variable !== undefined) {
      return {
        ok: false,
        code: "CREDENTIAL_IN_ANCESTOR",
        message:
          `--approval-policy auto-approve refused: ancestor process ${pid} (${stat.name}) holds ` +
          `${variable}, which a Tool Call could read; start Coding Agent with exec so that no ` +
          "process above it keeps the credential",
      };
    }
    pid = stat.parent;
  }
  return { ok: true };
}
