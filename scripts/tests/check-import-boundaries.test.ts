import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findImportViolations } from "../check-import-boundaries.ts";

const roots: string[] = [];

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "import-boundaries-"));
  roots.push(root);
  const tree: Record<string, string> = {
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/agent-core/package.json": "{}",
    "packages/agent-core/src/events.ts": "export type SessionEvent = string;\n",
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
        'import type { SessionEvent } from "../../agent-core/src/events.ts";\n',
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
    ]);
  });

  it("reports path aliases but not scoped package names", async () => {
    const root = await repository({
      "packages/tools/src/index.ts": [
        'import type { SessionEvent } from "@coding-agent/agent-core";',
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
