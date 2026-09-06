import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Parses raw .env content into key-value pairs.
 * Trims whitespace, strips enclosing quotes, and ignores comments (#) and empty lines.
 */
export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    let val = line.slice(eqIndex + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    if (key) {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Searches upward from startDir for the first `.env` file and loads its variables into process.env.
 * Does not overwrite existing environment variables.
 */
export function loadRootEnv(startDir = import.meta.dir): string | undefined {
  let currentDir = startDir;
  while (currentDir !== dirname(currentDir)) {
    const envPath = resolve(currentDir, ".env");
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, "utf-8");
        const parsed = parseEnv(content);
        for (const [key, val] of Object.entries(parsed)) {
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
        return envPath;
      } catch {
        return undefined;
      }
    }
    currentDir = dirname(currentDir);
  }
  return undefined;
}
