import { readFileSync } from "node:fs";
import { dropPtraceCapability } from "../../src/ptrace-capability.ts";

const result = dropPtraceCapability();
if (!result.ok) throw new Error(result.message);

process.stdout.write(readFileSync("/proc/thread-self/status", "utf8"));
