import { join } from "node:path";
import { parse } from "acorn";
import { simple } from "acorn-walk";
import type { BunPlugin } from "bun";

const root = join(import.meta.dir, "..");
let failed = false;

// Bun's packages: "external" also externalizes #src/ imports, so bare specifiers are matched here.
const externalPackages: BunPlugin = {
  name: "external-packages",
  setup(build) {
    build.onResolve({ filter: /^[^.#/]/ }, ({ path }) => ({ path, external: true }));
  },
};

for (const name of ["ai", "agent-core", "tools", "tui"]) {
  const build = await Bun.build({
    entrypoints: [join(root, "packages", name, "src", "index.ts")],
    target: "bun",
    plugins: [externalPackages],
    throw: false,
  });
  const output = build.outputs[0];

  if (!build.success || output === undefined) {
    console.error(`Failed to bundle @coding-agent/${name}:`);
    for (const log of build.logs) console.error(log);
    failed = true;
    continue;
  }

  const code = await output.text();
  const source = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  let hasSiblingImport = false;
  function check(value: unknown, start: number, end: number): void {
    if (typeof value === "string" && value.startsWith("@coding-agent/")) {
      console.error(`@coding-agent/${name}: forbidden runtime import: ${code.slice(start, end)}`);
      hasSiblingImport = true;
      failed = true;
    }
  }
  simple(source, {
    ImportDeclaration(node) {
      check(node.source.value, node.start, node.end);
    },
    ExportNamedDeclaration(node) {
      if (node.source) check(node.source.value, node.start, node.end);
    },
    ExportAllDeclaration(node) {
      check(node.source.value, node.start, node.end);
    },
    ImportExpression(node) {
      if (node.source.type === "Literal") check(node.source.value, node.start, node.end);
    },
    CallExpression(node) {
      // Bun rewrites require() to an import.meta.require alias in Bun-target bundles.
      const callee = code.slice(node.callee.start, node.callee.end);
      const argument = node.arguments[0];
      if (
        /^(?:require|__require\d*|import\.meta\.require)$/.test(callee) &&
        argument?.type === "Literal"
      ) {
        check(argument.value, node.start, node.end);
      }
    },
  });
  if (!hasSiblingImport) {
    console.log(`@coding-agent/${name}: no runtime sibling imports`);
  }
}

if (failed) process.exitCode = 1;
