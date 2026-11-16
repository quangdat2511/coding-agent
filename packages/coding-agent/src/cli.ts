#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Exit 2 means no Agent Session was opened (ADR 0005 §3). Usage errors are decided before any file
// or environment access, and configuration errors before any Agent Session opens; a run that opens
// none removes the output directory it created.
import { checkAncestorCredentials } from "./ancestor-credentials.ts";
import { createConfiguredChildLauncher } from "./child-launcher.ts";
import { runHeadless } from "./headless.ts";
import { markProcessNonDumpable } from "./non-dumpable.ts";
import { parseRunArgs, USAGE } from "./run-args.ts";

// A stream calls back in order, so once its last write has called back, everything was written.
function trackedWriter(stream: NodeJS.WriteStream) {
  let last = Promise.resolve();
  return {
    write: (text: string): void => {
      last = new Promise((resolve) => {
        try {
          stream.write(text, () => resolve());
        } catch {
          resolve();
        }
      });
    },
    written: () => last,
  };
}

const stdout = trackedWriter(process.stdout);
const stderr = trackedWriter(process.stderr);

type CancellingSignal = "SIGINT" | "SIGTERM";

// A first signal cancels, as soon as an Agent Session can take `cancel`. A repeated one while none
// can ends the process, so a run stuck before its Agent Session opens can still be stopped.
function listenForCancellation() {
  const cancellation = new AbortController();
  let sessionOpened = false;
  const stopListening = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  function onSignal(signal: CancellingSignal) {
    if (cancellation.signal.aborted && !sessionOpened) {
      stopListening();
      process.kill(process.pid, signal);
      return;
    }
    cancellation.abort(signal);
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    signal: cancellation.signal,
    onSessionOpened: () => {
      sessionOpened = true;
    },
    stopListening,
  };
}

async function main(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const parsed = parseRunArgs(argv, cwd);
  if (!parsed.ok) {
    stderr.write(`coding-agent: ${parsed.message}\n\n${USAGE}\n`);
    return 2;
  }
  // ADR 0001 §8 rule 2. Keep this right after argument parsing, so a usage error still exits 2
  // before any I/O, and ahead of configuration and command dispatch, so that it precedes every
  // Tool Call and Verification child on both entry points and under both Approval Policies. The
  // modules imported above run before main, so they must not start a child when they load.
  const hardened = markProcessNonDumpable();
  if (!hardened.ok) {
    stderr.write(
      `coding-agent: cannot mark the process non-dumpable, so no child can be started safely: ${hardened.message}\n`,
    );
    return 70;
  }
  const children = createConfiguredChildLauncher();
  if (!children.ok) {
    stderr.write(`coding-agent: ${children.message}\n`);
    return 2;
  }
  // createDefaultTools(children.launcher) gives bash this launcher; CDA-80 (D5) registers it with
  // the Agent Session, and CDA-74 gives it to the Verification Runner. Creating it validates
  // configuration without spawning a process.
  // Bun reports a write to a closed pipe as an "error" event, which would end the run with exit 1.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  const cancellation = listenForCancellation();
  try {
    // ADR 0001 §8, startup verification. Before configuration, so that a refused launch writes
    // nothing, and before any Agent Session opens. It does nothing unless the policy is
    // "auto-approve" and the platform is Linux.
    const ancestors = await checkAncestorCredentials(parsed.args.approvalPolicy);
    if (!ancestors.ok) {
      stderr.write(`coding-agent: ${ancestors.message}\n`);
      return ancestors.code === "CREDENTIAL_IN_ANCESTOR" ? 2 : 70;
    }
    const { exitCode } = await runHeadless({
      args: parsed.args,
      cwd,
      env,
      stdout: stdout.write,
      stderr: stderr.write,
      signal: cancellation.signal,
      onSessionOpened: cancellation.onSessionOpened,
    });
    return exitCode;
  } finally {
    // The run has written its files, so a later signal ends the process the default way.
    cancellation.stopListening();
  }
}

// Keep the 70 fallback, since an uncaught throw exits 1, a failed Agent Result.
try {
  process.exitCode = await main(process.argv.slice(2), process.cwd(), process.env);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  stderr.write(`coding-agent: internal error: ${reason}\n`);
  process.exitCode = 70;
}
// Work that outlived the Agent Result would hold the process open, so it exits once its output is
// written: `process.exit()` drops piped output whose write has not called back yet.
await Promise.all([stdout.written(), stderr.written()]);
process.exit();
