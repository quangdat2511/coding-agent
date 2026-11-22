// PROTOTYPE, THROWAWAY (CDA-121). Compiled with `bun build --compile` and run in a task container.
// Usage: proto <variant>, variant = none | effective | bounding | all
//   none      : only the non-dumpable mark (what the 1fd9966 artifact does)
//   effective : + capset clears CAP_SYS_PTRACE from effective, permitted, inheritable
//   bounding  : + prctl(PR_CAPBSET_DROP, CAP_SYS_PTRACE) only
//   all       : bounding + effective
// It holds ANTHROPIC_API_KEY in its own startup environment, starts `sh probe.sh` with the key
// removed, and prints what the child could read.
import { dlopen, ptr, read } from "bun:ffi";
import { readFileSync } from "node:fs";

const PR_SET_DUMPABLE = 4;
const PR_CAPBSET_READ = 23;
const PR_CAPBSET_DROP = 24;
const PR_CAP_AMBIENT = 47;
const PR_CAP_AMBIENT_IS_SET = 1;
const CAP_SYS_PTRACE = 19;
const LINUX_CAPABILITY_VERSION_3 = 0x20080522;

const variant = process.argv[2] ?? "none";
const say = (text: string) => console.log(`[parent ${variant}] ${text}`);

const lib = dlopen("libc.so.6", {
  prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
  capget: { args: ["ptr", "ptr"], returns: "i32" },
  capset: { args: ["ptr", "ptr"], returns: "i32" },
  __errno_location: { args: [], returns: "ptr" },
});
const { prctl, capget, capset, __errno_location } = lib.symbols;
const errno = () => {
  const p = __errno_location();
  return p === null ? 0 : read.i32(p);
};

function status(): string {
  return readFileSync("/proc/self/status", "utf8")
    .split("\n")
    .filter((l) => /^(Uid|Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp)\s*:/.test(l))
    .map((l) => l.replace(/\s+/g, " "))
    .join(" | ");
}

say(`uname ${readFileSync("/proc/sys/kernel/osrelease", "utf8").trim()}`);
say(`before: ${status()}`);
say(`key in my env: ${process.env.ANTHROPIC_API_KEY ? "yes" : "NO (bad setup)"}`);

const r = prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
say(`prctl(PR_SET_DUMPABLE,0) = ${r} errno ${r ? errno() : 0}`);

if (variant === "bounding" || variant === "all") {
  const d = prctl(PR_CAPBSET_DROP, CAP_SYS_PTRACE, 0, 0, 0);
  say(`prctl(PR_CAPBSET_DROP, 19) = ${d} errno ${d ? errno() : 0}`);
}
if (variant === "effective" || variant === "all") {
  const header = new Uint32Array([LINUX_CAPABILITY_VERSION_3, 0]);
  const data = new Uint32Array(6); // 2 x {effective, permitted, inheritable}
  const g = capget(ptr(header), ptr(data));
  say(`capget = ${g} errno ${g ? errno() : 0} data=${[...data].map((x) => x.toString(16))}`);
  const mask = ~(1 << CAP_SYS_PTRACE) >>> 0;
  data[0] = (data[0]! & mask) >>> 0;
  data[1] = (data[1]! & mask) >>> 0;
  data[2] = (data[2]! & mask) >>> 0;
  header[1] = 0;
  const s = capset(ptr(header), ptr(data));
  say(`capset(clear bit 19 in eff/prm/inh) = ${s} errno ${s ? errno() : 0}`);
}

say(`PR_CAPBSET_READ(19) = ${prctl(PR_CAPBSET_READ, CAP_SYS_PTRACE, 0, 0, 0)}`);
say(`PR_CAP_AMBIENT_IS_SET(19) = ${prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, CAP_SYS_PTRACE, 0, 0)}`);
say(`after: ${status()}`);
import { readdirSync } from "node:fs";
for (const tid of readdirSync("/proc/self/task")) {
  const st = readFileSync(`/proc/self/task/${tid}/status`, "utf8");
  const pick = (k: string) => st.match(new RegExp(`^${k}:\\s*(\\S+)`, "m"))?.[1];
  say(`thread ${tid} ${pick("Name")} CapEff=${pick("CapEff")} CapPrm=${pick("CapPrm")} CapBnd=${pick("CapBnd")}`);
}

const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
say("--- child via Bun.spawnSync");
const child = Bun.spawnSync(["sh", "/proto/probe.sh"], { env, stdout: "pipe", stderr: "pipe" });
console.log(child.stdout.toString());
if (child.stderr.length) console.log(`[child stderr] ${child.stderr.toString()}`);
say("--- child via async Bun.spawn (as packages/tools does)");
await Bun.sleep(50);
const a = Bun.spawn(["sh", "/proto/probe.sh"], { env, stdout: "pipe", stderr: "pipe" });
console.log(await new Response(a.stdout).text());
await a.exited;
