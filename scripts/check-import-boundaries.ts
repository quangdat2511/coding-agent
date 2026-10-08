import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const SPECIFIERS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["'`]([^"'`\n]+)["'`]/g,
  /\brequire\s*\(\s*["'`]([^"'`\n]+)["'`]/g,
];
const PATH_ALIAS = /^@(?:tests|examples)?\//;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

async function workspacePackages(root: string): Promise<string[]> {
  const { workspaces } = (await Bun.file(join(root, "package.json")).json()) as {
    workspaces: string[];
  };
  const manifests = await Promise.all(
    workspaces.map((pattern) =>
      Array.fromAsync(new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root })),
    ),
  );
  return manifests.flat().map((manifest) => dirname(manifest));
}

async function sourceFiles(root: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...(await sourceFiles(root, path)));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function violations(
  root: string,
  file: string,
  packageDirectory: string,
  source: string,
): string[] {
  const found: string[] = [];
  const matches = SPECIFIERS.flatMap((pattern) => [...source.matchAll(pattern)]);
  for (const match of matches.sort((a, b) => a.index - b.index)) {
    const specifier = match[1] ?? "";
    const line = source.slice(0, match.index).split("\n").length;
    if (PATH_ALIAS.test(specifier)) {
      found.push(`${file}:${line}: "${specifier}" is a path alias; use a relative import`);
      continue;
    }
    if (!specifier.startsWith(".") || specifier.includes("${")) continue;
    const target = relative(join(root, packageDirectory), resolve(root, dirname(file), specifier));
    if (target === ".." || target.startsWith(`..${sep}`)) {
      found.push(
        `${file}:${line}: "${specifier}" resolves outside ${packageDirectory}; import that package by name`,
      );
    }
  }
  return found;
}

async function owningPackage(root: string, file: string): Promise<string> {
  let directory = dirname(file);
  while (directory !== "." && !(await Bun.file(join(root, directory, "package.json")).exists())) {
    directory = dirname(directory);
  }
  return directory;
}

export async function findImportViolations(root: string, files?: string[]): Promise<string[]> {
  const packages = await workspacePackages(root);
  const candidates =
    files?.map((file) => relative(root, resolve(root, file))) ??
    (await Promise.all(packages.map((directory) => sourceFiles(root, directory)))).flat();
  const found: string[] = [];
  for (const file of candidates) {
    const sourceFile = Bun.file(join(root, file));
    if (!(await sourceFile.exists())) {
      found.push(`${file}: file not found`);
      continue;
    }
    const packageDirectory = await owningPackage(root, file);
    if (!packages.includes(packageDirectory)) continue;
    const source = await sourceFile.text();
    found.push(...violations(root, file, packageDirectory, source));
  }
  return found;
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  const found = await findImportViolations(
    join(import.meta.dir, ".."),
    files.length > 0 ? files : undefined,
  );
  for (const violation of found) console.error(violation);
  if (found.length > 0) process.exitCode = 1;
}
