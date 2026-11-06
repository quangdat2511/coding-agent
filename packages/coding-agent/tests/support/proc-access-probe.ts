// Preloaded into a target process with `bun --preload`, or run as the target itself. When the
// target exits, the probe starts read-proc.ts as a same-uid child against the target and writes the
// child's report to the file that PROC_ACCESS_REPORT names. Linux only.
//
// Yama's ptrace_scope 1, Ubuntu's default, already stops a child from opening its parent's
// /proc/<pid>/mem. The probe declares any process a permitted tracer of the target, which lifts
// that restriction, so only dumpability decides the outcome. Without this step the mem assertion
// would pass on Ubuntu even if nothing marked the target non-dumpable. The report says whether the
// step succeeded, in ptracerLifted.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLibc } from "../../src/non-dumpable.ts";

// <linux/prctl.h>
const PR_SET_PTRACER = 0x59616d61;
const PR_SET_PTRACER_ANY = 0xffffffffffffffffn;

const report = process.env.PROC_ACCESS_REPORT;
if (report === undefined) throw new Error("PROC_ACCESS_REPORT is not set");

const libc = openLibc();
// This fails with EINVAL when Yama is not loaded, and then there is no restriction to lift.
const ptracerLifted = libc.prctl(PR_SET_PTRACER, PR_SET_PTRACER_ANY, 0, 0, 0) === 0;
libc.close();

const reader = join(import.meta.dir, "read-proc.ts");

process.on("exit", () => {
  const child = Bun.spawnSync([process.execPath, reader, String(process.pid)], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  writeFileSync(
    report,
    child.success
      ? JSON.stringify({ ...JSON.parse(child.stdout.toString()), ptracerLifted })
      : `reader failed: ${child.stderr}`,
  );
});
