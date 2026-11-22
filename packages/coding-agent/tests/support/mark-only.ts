// A target for proc-access-probe.ts that does what Coding Agent did before CDA-121: it marks itself
// non-dumpable and nothing more. A same-uid reader that holds CAP_SYS_PTRACE still reads it.
import { markProcessNonDumpable } from "../../src/non-dumpable.ts";

const marked = markProcessNonDumpable();
if (!marked.ok) throw new Error(marked.message);
