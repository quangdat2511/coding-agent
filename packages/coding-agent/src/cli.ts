#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// Exit 2 means no Agent Session was opened (ADR 0005 §3). Usage errors are decided before any file
// or environment access, and configuration errors before any Agent Session opens; a run that opens
// none removes the output directory it created. `coding-agent run` is the headless path; a command
// line of flags alone is the interactive path, which opens one Agent Session per Coding Task.
import { checkAncestorCredentials } from "./ancestor-credentials.ts";
import { BUILD_INFO, formatVersion } from "./build-info.ts";
import { createConfiguredChildLauncher } from "./child-launcher.ts";
import { parseCommandLine } from "./command-line.ts";
import { diagnostic } from "./diagnostics.ts";
import { runHeadless } from "./headless.ts";
import { markProcessNonDumpable } from "./non-dumpable.ts";
import { dropPtraceCapability } from "./ptrace-capability.ts";

// A stream calls back in order, so once its last write has called back, everything was written.
function trackedWriter(stream: NodeJS.WriteStream) {
  let last = Promise.resolve();
  return {
    write: (text: string): void => {
      const previous = last;
      last = new Promise((resolve) => {
        try {
          stream.write(text, () => resolve());
        } catch {
          resolve(previous);
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
  // The Harbor adapter compares this line with artifact-manifest.json (ADR 0005 §6). It opens no
  // Agent Session and starts no child, so it needs no hardening.
  if (argv.length === 1 && argv[0] === "--version") {
    stdout.write(`${formatVersion(BUILD_INFO)}\n`);
    return 0;
  }
  const parsed = parseCommandLine(argv, cwd);
  if (!parsed.ok) {
    stderr.write(`${diagnostic(parsed.message)}\n${parsed.usage}\n`);
    return 2;
  }
  // ADR 0001 §8 rule 2. Keep this right after argument parsing, so a usage error still exits 2
  // before any I/O, and ahead of configuration and command dispatch, so that it precedes every
  // Tool Call and Verification child on both entry points and under both Approval Policies. The
  // modules imported above run before main, so they must not start a child when they load. The
  // CAP_SYS_PTRACE drop below applies to "auto-approve" only.
  const hardened = markProcessNonDumpable();
  if (!hardened.ok) {
    stderr.write(
      diagnostic(
        `cannot mark the process non-dumpable, so no child can be started safely: ${hardened.message}`,
      ),
    );
    return 70;
  }
  // The "auto-approve" steps, in this order. The interactive path runs under "ask", which ADR 0001
  // §8 exempts from both, so it keeps its capabilities and skips the ancestor check
  // (ADR 0006, Join 3).
  if (parsed.args.approvalPolicy === "auto-approve") {
    // ADR 0001 §8, startup verification. Before the capability drop, on purpose: it reads each
    // ancestor's environment as this process can, and with CAP_SYS_PTRACE still held that includes a
    // root launcher that holds the capability itself. After the drop it would read as a child can,
    // and on Modal it would pass such a launcher over, so the launch contract would go unchecked.
    // Before configuration, so that a refused launch writes nothing, and before any Agent Session
    // opens. It does nothing unless the platform is Linux.
    const ancestors = await checkAncestorCredentials();
    if (!ancestors.ok) {
      stderr.write(diagnostic(ancestors.message));
      return ancestors.code === "CREDENTIAL_IN_ANCESTOR" ? 2 : 70;
    }
    // ADR 0001 §8, CDA-121 amendment. A child that holds CAP_SYS_PTRACE can read a Coding Agent
    // process that is non-dumpable, so the capability goes before the first child.
    const dropped = dropPtraceCapability();
    if (!dropped.ok) {
      stderr.write(diagnostic(dropped.message));
      return dropped.code === "CAPABILITY_REMAINS" ? 2 : 70;
    }
  }
  const children = createConfiguredChildLauncher();
  if (!children.ok) {
    stderr.write(diagnostic(children.message));
    return 2;
  }
  // Bun reports a write to a closed pipe as an "error" event, which would end the run with exit 1.
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  const cancellation = listenForCancellation();
  try {
    // The interactive path goes straight on. The hardening above still applies to it.
    if (parsed.command === "interactive") {
      // Loaded here, not at the top, so a headless run never loads the TUI and its Yoga layout
      // engine: they are startup cost and a failure surface that `coding-agent run` does not need.
      const { runInteractive } = await import("./interactive.ts");
      return await runInteractive({
        args: parsed.args,
        cwd,
        env,
        stderr: stderr.write,
        launcher: children.launcher,
        signal: cancellation.signal,
        isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        onReady: cancellation.onSessionOpened,
      });
    }
    const { exitCode } = await runHeadless({
      args: parsed.args,
      cwd,
      env,
      stdout: stdout.write,
      stderr: stderr.write,
      launcher: children.launcher,
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
  stderr.write(diagnostic(`internal error: ${reason}`));
  process.exitCode = 70;
}
// Work that outlived the Agent Result would hold the process open, so it exits once its output is
// written: `process.exit()` drops piped output whose write has not called back yet.
await Promise.all([stdout.written(), stderr.written()]);
process.exit();
