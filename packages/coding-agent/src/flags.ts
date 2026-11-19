// The flag-reading library of the command line, shared by `coding-agent run` (run-args.ts) and the
// interactive path (interactive-args.ts), so both refuse a bad invocation in the same words. Keep
// this module import-free so usage errors are decided before any I/O. Values stay verbatim;
// resolving paths, reading files, and checking credentials or models belong in run-config.ts.

export type ProviderId = "anthropic" | "openrouter" | "openai" | "google" | "xai" | "opencode";

export const providers = {
  anthropic: true,
  openrouter: true,
  openai: true,
  google: true,
  xai: true,
  opencode: true,
} satisfies Record<ProviderId, true>;

// The options that both command lines take: which model to talk to, and which repository.
export interface SessionFlags {
  readonly provider: ProviderId;
  readonly model: string;
  readonly repoRoot: string;
}

export const sessionFlagOf = {
  provider: "--provider",
  model: "--model",
  repoRoot: "--repo-root",
} as const satisfies Record<keyof SessionFlags, `--${string}`>;

// What each of those flags means, so that both usages say it in the same words.
export const sessionFlagHelp = {
  provider: [
    `${sessionFlagOf.provider} <provider>`,
    `required  ${Object.keys(providers).join(" | ")}`,
  ],
  model: [`${sessionFlagOf.model} <model-id>`, "required  model identifier within that provider"],
  repoRoot: [`${sessionFlagOf.repoRoot} <dir>`, "optional  defaults to the working directory"],
} as const satisfies Record<keyof SessionFlags, readonly [string, string]>;

// A usage's list of flags, each followed by its description, in aligned columns.
export function flagTable(rows: readonly (readonly [flag: string, description: string])[]): string {
  const width = Math.max(...rows.map(([flag]) => flag.length)) + 2;
  return rows.map(([flag, text]) => `  ${flag.padEnd(width)}${text}`).join("\n");
}

export interface UsageError {
  readonly ok: false;
  readonly code: "USAGE_ERROR";
  readonly message: string;
  readonly flag?: string;
}

export type UsageProblem = Pick<UsageError, "flag" | "message">;

export const problem = (flag: string | undefined, message: string): UsageProblem =>
  flag === undefined ? { message } : { flag, message };

export const fail = (found: UsageProblem): UsageError => ({
  ok: false,
  code: "USAGE_ERROR",
  ...found,
});

const oneOf = (options: object): string => {
  const names = Object.keys(options);
  return names.length === 1 ? `"${names[0]}"` : `one of ${names.join(", ")}`;
};

export function requireValue(flag: string, raw: string | undefined): string | UsageProblem {
  return raw === undefined ? problem(flag, `${flag} is required`) : raw;
}

export function requireOneOf<T extends string>(
  flag: string,
  raw: string | undefined,
  options: Record<T, true>,
): T | UsageProblem {
  if (raw === undefined) return problem(flag, `${flag} is required`);
  return Object.hasOwn(options, raw)
    ? (raw as T)
    : problem(flag, `${flag} must be ${oneOf(options)}, not "${raw}"`);
}

// The field that each flag sets, from the field-to-flag record of a command line.
export function fieldsOf<Field extends string>(
  flags: Readonly<Record<Field, string>>,
): ReadonlyMap<string, Field> {
  return new Map(
    (Object.entries(flags) as [Field, string][]).map(([field, flag]): [string, Field] => [
      flag,
      field,
    ]),
  );
}

// Reads `--flag value` and `--flag=value` tokens into the field each flag names.
export function readFlags<Field extends string>(
  tokens: readonly string[],
  fieldOf: ReadonlyMap<string, Field>,
): { readonly raw: Partial<Record<Field, string>> } | { readonly problem: UsageProblem } {
  const raw: Partial<Record<Field, string>> = {};
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) break;

    const separator = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = separator === -1 ? token : token.slice(0, separator);
    const field = fieldOf.get(flag);
    if (field === undefined) {
      return {
        problem: token.startsWith("-")
          ? problem(flag, `unknown flag "${flag}"`)
          : problem(undefined, `unexpected argument "${token}"`),
      };
    }
    if (raw[field] !== undefined)
      return { problem: problem(flag, `${flag} was given more than once`) };

    let value = separator === -1 ? undefined : token.slice(separator + 1);
    const next = tokens[index + 1];
    if (separator === -1 && next !== undefined && !next.startsWith("-")) {
      value = next;
      index++;
    }
    if (value === undefined || value.trim() === "") {
      return { problem: problem(flag, `${flag} requires a value`) };
    }
    raw[field] = value;
  }
  return { raw };
}
