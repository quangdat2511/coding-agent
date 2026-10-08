import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

// ADR 0004 §5 keeps Ink out of tui's public types. React types would expose the renderer the
// same way.
const FORBIDDEN_MODULE = /^(?:ink|react)(?:\/|$)/;
const FORBIDDEN_NAMESPACE = /\b(?:React|JSX)\./g;

// Every way a declaration file names another module: import/export ... from "x", import "x",
// import("x"), import x = require("x") and /// <reference types="x" />.
const MODULE_SPECIFIERS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /<reference\s+types\s*=\s*["']([^"']+)["']/g,
];

const packageRoot = join(import.meta.dir, "..");

// TypeScript 7 has no stable compiler API (its package exports only the version), so the test
// runs the same tsc CLI as the typecheck script, under Bun so that node is not required.
const tsc = join(dirname(Bun.resolveSync("typescript/package.json", packageRoot)), "bin", "tsc");

async function emitDeclarations(directory: string): Promise<string> {
  const outDir = join(directory, "declarations");
  const project = join(directory, "tsconfig.json");
  await writeFile(
    project,
    JSON.stringify({
      extends: join(packageRoot, "tsconfig.json"),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        removeComments: true,
        rootDir: join(packageRoot, "src"),
        outDir,
        // Type roots are looked up from the project file, which lives outside the repository.
        typeRoots: [join(packageRoot, "..", "..", "node_modules", "@types")],
      },
      files: [join(packageRoot, "src", "index.ts")],
      include: [],
    }),
  );
  const compiler = Bun.spawn([process.execPath, tsc, "--project", project], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    compiler.exited,
    new Response(compiler.stdout).text(),
    new Response(compiler.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`tsc exited with code ${exitCode}:\n${stdout}${stderr}`);
  }
  return outDir;
}

function moduleSpecifiers(declarations: string): string[] {
  return MODULE_SPECIFIERS.flatMap((pattern) =>
    [...declarations.matchAll(pattern)].flatMap(([, specifier]) => specifier ?? []),
  );
}

// The path a local specifier points to, or undefined for another package.
function localPath(specifier: string, importer: string): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolve(dirname(importer), specifier);
  }
  return undefined;
}

function declarationFile(path: string): string | undefined {
  const stem = path.replace(/\.[cm]?[jt]sx?$/, "");
  return [`${stem}.d.ts`, join(stem, "index.d.ts")].find((candidate) => existsSync(candidate));
}

// Follows the entry point through every local import and checks each declaration file reached.
async function inspectPublicDeclarations(outDir: string) {
  const reachable = new Set<string>();
  const violations: string[] = [];
  const pending = [join(outDir, "index.d.ts")];
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || reachable.has(file)) continue;
    reachable.add(file);
    const name = relative(outDir, file);
    const declarations = await readFile(file, "utf8");
    for (const specifier of moduleSpecifiers(declarations)) {
      if (FORBIDDEN_MODULE.test(specifier)) {
        violations.push(`${name} imports "${specifier}"`);
        continue;
      }
      const local = localPath(specifier, file);
      if (local === undefined) continue;
      const declaration = declarationFile(local);
      if (declaration === undefined) {
        violations.push(`${name} imports "${specifier}", which has no declaration file`);
      } else {
        pending.push(declaration);
      }
    }
    for (const [namespace] of declarations.matchAll(FORBIDDEN_NAMESPACE)) {
      violations.push(`${name} uses the ${namespace} namespace`);
    }
  }
  return { reachable: [...reachable].map((file) => relative(outDir, file)), violations };
}

describe("public declarations", () => {
  it("name no Ink or React type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tui-public-types-"));
    try {
      const { reachable, violations } = await inspectPublicDeclarations(
        await emitDeclarations(directory),
      );
      // index.d.ts reaches these only through relative imports, so the walk must follow them.
      expect(reachable).toContain("render.d.ts");
      expect(reachable).toContain("types.d.ts");
      expect(violations).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
