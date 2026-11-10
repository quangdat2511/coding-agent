// A same-uid child, as a Tool Call child would be. It tries to read another process's /proc files
// and prints the outcome of each as JSON: "read", or the error code. From environ it prints the
// variable names only, never the values.
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { errnoOf } from "@coding-agent/tools";

const pid = process.argv[2];
if (pid === undefined) throw new Error("usage: read-proc.ts <pid>");

const outcome = (attempt: () => void): string => {
  try {
    attempt();
    return "read";
  } catch (error) {
    return errnoOf(error) ?? String(error);
  }
};

let environNames: string[] = [];
const environ = outcome(() => {
  environNames = readFileSync(`/proc/${pid}/environ`, "latin1")
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.split("=")[0] ?? "");
});
// Opening is the access check, and it asks for attach-mode ptrace access. A read at offset 0 would
// fail even after a successful open, because nothing is mapped there.
const mem = outcome(() => closeSync(openSync(`/proc/${pid}/mem`, "r")));
// Following a link is what would expose an open file, and it needs ptrace read access. Listing the
// directory is not enough: a caller with DAC override, such as root without CAP_SYS_PTRACE, can
// list the fd numbers of a non-dumpable process. A descriptor that closes meanwhile is skipped.
const fd = outcome(() => {
  for (const entry of readdirSync(`/proc/${pid}/fd`)) {
    try {
      readlinkSync(`/proc/${pid}/fd/${entry}`);
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") throw error;
    }
  }
});

process.stdout.write(JSON.stringify({ environ, environNames, mem, fd }));
