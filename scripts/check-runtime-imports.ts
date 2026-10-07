import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "acorn";
import { simple } from "acorn-walk";

const root = join(import.meta.dir, "..");
const outputDirectory = await mkdtemp(join(tmpdir(), "coding-agent-imports-"));
let failed = false;

try {
  for (const name of ["ai", "agent-core", "tools", "tui"]) {
    const output = join(outputDirectory, `${name}.js`);
    // Third-party packages stay unbundled: only the package's own code can import a sibling, and
    // bundling dependencies fails on optional peers that are not installed, such as Ink's
    // react-devtools-core. Relative imports are still bundled, so every package file is checked.
    const build = Bun.spawnSync(
      [
        process.execPath,
        "build",
        `packages/${name}/src/index.ts`,
        "--target",
        "bun",
        "--packages",
        "external",
        "--external",
        "@coding-agent/*",
        "--outfile",
        output,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );

    if (build.exitCode !== 0) {
      console.error(`Failed to bundle @coding-agent/${name}:`);
      console.error(build.stdout.toString(), build.stderr.toString());
      failed = true;
      continue;
    }

    const code = await Bun.file(output).text();
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
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
