import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { displayPath, findImportViolations } from "../check-import-boundaries.ts";

const roots: string[] = [];

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "import-boundaries-"));
  roots.push(root);
  const tree: Record<string, string> = {
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/agent-core/package.json": "{}",
    "packages/agent-core/src/events.ts": "export type RunEvent = string;\n",
    "packages/tools/package.json": "{}",
    ...files,
  };
  for (const [path, content] of Object.entries(tree)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("findImportViolations", () => {
  it.each([
    'process.getBuiltinModule("node:child_process");',
    'process["getBuiltinModule"]("node:cluster");',
    "const load = process.getBuiltinModule;",
    "const { getBuiltinModule: load } = process;",
    'import { getBuiltinModule as load } from "node:process"; load("node:cluster");',
  ])("rejects builtin-module loader access in tools source: %s", async (source) => {
    const root = await repository({ "packages/tools/src/probe.ts": source });

    expect(await findImportViolations(root)).toEqual([
      "packages/tools/src/probe.ts: getBuiltinModule bypasses the shared child launcher; use the injected ChildProcessLauncher",
    ]);
  });

  it.each([
    'import.meta.require("node:child_process");',
    'import.meta["require"]("node:cluster");',
    "const load = import.meta.require;",
    "const { require: load } = import.meta;",
  ])("rejects import.meta loader access in tools source: %s", async (source) => {
    const root = await repository({ "packages/tools/src/probe.ts": source });

    expect(await findImportViolations(root)).toEqual([
      "packages/tools/src/probe.ts: import.meta.require bypasses the shared child launcher; use the injected ChildProcessLauncher",
    ]);
  });

  it("does not treat comments or strings as raw module-loader access", async () => {
    const root = await repository({
      "packages/tools/src/probe.ts": [
        "// process.getBuiltinModule and import.meta.require are forbidden.",
        'export const documentation = "process.getBuiltinModule and import.meta.require";',
      ].join("\n"),
    });

    expect(await findImportViolations(root)).toEqual([]);
  });

  it("keeps loader restrictions scoped to tools production files outside the launch module", async () => {
    const source = 'process.getBuiltinModule("node:child_process");';
    const root = await repository({
      "packages/tools/src/child-process.ts": source,
      "packages/tools/tests/probe.test.ts": source,
      "packages/agent-core/src/probe.ts": source,
    });

    expect(await findImportViolations(root)).toEqual([]);
  });

  it("accepts relative imports that stay inside the package", async () => {
    const root = await repository({
      "packages/tools/src/index.ts": 'export { read } from "./tools/read.ts";\n',
      "packages/tools/src/tools/read.ts": 'import type { Tool } from "../tool.ts";\n',
      "packages/tools/tests/read.test.ts": 'const { read } = await import("../src/index.ts");\n',
    });

    expect(await findImportViolations(root)).toEqual([]);
  });

  it("reports a relative import that resolves into a sibling package", async () => {
    const root = await repository({
      "packages/tools/src/index.ts":
        'import type { RunEvent } from "../../agent-core/src/events.ts";\n',
    });

    expect(await findImportViolations(root)).toEqual([
      'packages/tools/src/index.ts:1: "../../agent-core/src/events.ts" resolves outside packages/tools; import that package by name',
    ]);
  });

  it("reports a dynamic import that resolves into a sibling package", async () => {
    const root = await repository({
      "packages/tools/src/index.ts":
        'export {};\n\nconst events = await import(\n  "../../agent-core/src/events.ts"\n);\n',
    });

    expect(await findImportViolations(root)).toEqual([
      'packages/tools/src/index.ts:3: "../../agent-core/src/events.ts" resolves outside packages/tools; import that package by name',
    ]);
  });

  it("reports a dynamic import written as a template literal without substitutions", async () => {
    const root = await repository({
      "packages/tools/src/index.ts": [
        "const events = await import(`../../agent-core/src/events.ts`);",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture source with a substitution
        "const computed = await import(`../../agent-core/src/${name}.ts`);",
        "",
      ].join("\n"),
    });

    expect(await findImportViolations(root)).toEqual([
      'packages/tools/src/index.ts:1: "../../agent-core/src/events.ts" resolves outside packages/tools; import that package by name',
    ]);
  });

  it("reports side-effect imports and requires that resolve into a sibling package", async () => {
    const root = await repository({
      "packages/tools/src/index.ts":
        'import "../../agent-core/src/events.ts";\nimport events = require("../../agent-core/src/events.ts");\n',
    });

    expect(await findImportViolations(root)).toEqual([
      'packages/tools/src/index.ts:1: "../../agent-core/src/events.ts" resolves outside packages/tools; import that package by name',
      'packages/tools/src/index.ts:2: "../../agent-core/src/events.ts" resolves outside packages/tools; import that package by name',
      "packages/tools/src/index.ts: import.meta.require bypasses the shared child launcher; use the injected ChildProcessLauncher",
    ]);
  });

  it("reports path aliases but not scoped package names", async () => {
    const root = await repository({
      "packages/tools/src/index.ts": [
        'import type { RunEvent } from "@coding-agent/agent-core";',
        'import { a } from "@/a";',
        'import { b } from "@tests/b";',
        'import { c } from "@examples/c";',
        "",
      ].join("\n"),
    });

    expect(await findImportViolations(root)).toEqual([
      'packages/tools/src/index.ts:2: "@/a" is a path alias; use a relative import',
      'packages/tools/src/index.ts:3: "@tests/b" is a path alias; use a relative import',
      'packages/tools/src/index.ts:4: "@examples/c" is a path alias; use a relative import',
    ]);
  });

  it("skips packages nested inside a workspace package and dependencies", async () => {
    const root = await repository({
      "packages/tui/package.json": "{}",
      "packages/tui/spike/package.json": "{}",
      "packages/tui/spike/src/index.ts": 'import { a } from "@/a";\n',
      "packages/tui/node_modules/ink/index.d.ts": 'export * from "../../../tools/src/index.ts";\n',
    });

    expect(await findImportViolations(root)).toEqual([]);
  });

  it("skips build output", async () => {
    const root = await repository({
      "packages/tools/dist/index.d.ts": 'export * from "../../agent-core/src/events.ts";\n',
    });

    expect(await findImportViolations(root)).toEqual([]);
  });

  it("reports given files that do not exist", async () => {
    const root = await repository({
      "packages/tools/src/index.ts": 'import { a } from "@/a";\n',
    });

    const files = [
      "packages/tools/src/deleted.ts",
      "packages/tols/src/index.ts",
      "packages/tools/src/index.ts",
    ];
    expect(await findImportViolations(root, files)).toEqual([
      "packages/tools/src/deleted.ts: file not found",
      "packages/tols/src/index.ts: file not found",
      'packages/tools/src/index.ts:1: "@/a" is a path alias; use a relative import',
    ]);
  });

  it("checks only the given files that belong to a workspace package", async () => {
    const root = await repository({
      "packages/tui/package.json": "{}",
      "packages/tui/spike/package.json": "{}",
      "packages/tui/spike/index.ts": 'import { a } from "@/a";\n',
      "packages/tools/src/index.ts": 'import { a } from "@/a";\n',
      "packages/tools/src/other.ts": 'import { b } from "@/b";\n',
      "scripts/check.ts": 'import { c } from "@/c";\n',
    });

    const files = [
      "packages/tui/spike/index.ts",
      "packages/tools/src/index.ts",
      "scripts/check.ts",
    ];
    expect(await findImportViolations(root, files)).toEqual([
      'packages/tools/src/index.ts:1: "@/a" is a path alias; use a relative import',
    ]);
  });
});

describe("displayPath", () => {
  it("normalizes Windows separators to the diagnostic form", () => {
    expect(displayPath("packages\\tools\\src\\index.ts", "\\")).toBe("packages/tools/src/index.ts");
  });

  it("leaves POSIX paths unchanged", () => {
    expect(displayPath("packages/tools/src/index.ts", "/")).toBe("packages/tools/src/index.ts");
  });
});
