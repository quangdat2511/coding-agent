import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, createChildProcessLauncher } from "../src/index.ts";

const keys = ["CDA68_PROVIDER_KEY", "GH_TOKEN", "CI", "TERM"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.CDA68_PROVIDER_KEY = "fake-provider-key";
  process.env.GH_TOKEN = "fake-task-A";
  process.env.CI = "0";
  process.env.TERM = "xterm";
});

afterEach(() => {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const printEnvironment = [
  process.execPath,
  "--no-env-file",
  "-e",
  `console.log(JSON.stringify({
    credential: process.env.CDA68_PROVIDER_KEY ?? null,
    taskToken: process.env.GH_TOKEN,
    ci: process.env.CI,
    term: process.env.TERM,
  }));`,
];

async function readChild(child: ChildProcess) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("launching a child process", () => {
  it("runs the child in the requested working directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "child-launcher-cwd-"));
    try {
      const configured = createChildProcessLauncher(["CDA68_PROVIDER_KEY"]);
      if (!configured.ok) throw new Error(configured.message);

      const result = await readChild(
        configured.launcher.launch(
          [process.execPath, "--no-env-file", "-e", "console.log(process.cwd());"],
          { cwd: directory },
        ),
      );

      expect(result).toEqual({
        exitCode: 0,
        stdout: `${await realpath(directory)}\n`,
        stderr: "",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "can start a POSIX child as the leader of a separate process group",
    async () => {
      const configured = createChildProcessLauncher(["CDA68_PROVIDER_KEY"]);
      if (!configured.ok) throw new Error(configured.message);

      const result = await readChild(
        configured.launcher.launch(
          [
            process.execPath,
            "--no-env-file",
            "-e",
            `const group = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)]);
             if (group.exitCode !== 0) process.exit(1);
             console.log(Number(group.stdout.toString().trim()) === process.pid);`,
          ],
          { detached: true },
        ),
      );

      expect(result).toEqual({ exitCode: 0, stdout: "true\n", stderr: "" });
    },
  );

  it("passes a filtered, non-interactive environment without changing the parent's environment", async () => {
    const configured = createChildProcessLauncher(["CDA68_PROVIDER_KEY"]);
    if (!configured.ok) throw new Error(configured.message);

    const { exitCode, stdout, stderr } = await readChild(
      configured.launcher.launch(printEnvironment),
    );

    expect({ exitCode, environment: JSON.parse(stdout), stderr }).toEqual({
      exitCode: 0,
      environment: { credential: null, taskToken: "fake-task-A", ci: "1", term: "dumb" },
      stderr: "",
    });
    expect({
      credential: process.env.CDA68_PROVIDER_KEY,
      taskToken: process.env.GH_TOKEN,
      ci: process.env.CI,
      term: process.env.TERM,
    }).toEqual({
      credential: "fake-provider-key",
      taskToken: "fake-task-A",
      ci: "0",
      term: "xterm",
    });
  });

  it("reads the current task environment at each launch rather than keeping a startup snapshot", async () => {
    const configured = createChildProcessLauncher(["CDA68_PROVIDER_KEY"]);
    if (!configured.ok) throw new Error(configured.message);
    const first = await readChild(configured.launcher.launch(printEnvironment));

    process.env.GH_TOKEN = "fake-task-B";
    process.env.CDA68_PROVIDER_KEY = "new-fake-provider-key";
    const second = await readChild(configured.launcher.launch(printEnvironment));

    expect([JSON.parse(first.stdout), JSON.parse(second.stdout)]).toEqual([
      { credential: null, taskToken: "fake-task-A", ci: "1", term: "dumb" },
      { credential: null, taskToken: "fake-task-B", ci: "1", term: "dumb" },
    ]);
  });

  it("does not accept a replacement environment, even from an untyped caller", async () => {
    const configured = createChildProcessLauncher(["CDA68_PROVIDER_KEY"]);
    if (!configured.ok) throw new Error(configured.message);

    const result = await readChild(
      configured.launcher.launch(printEnvironment, {
        // @ts-expect-error the public launch interface deliberately has no env option
        env: { CDA68_PROVIDER_KEY: "reintroduced-secret", GH_TOKEN: "replacement-token" },
      }),
    );

    expect(JSON.parse(result.stdout)).toEqual({
      credential: null,
      taskToken: "fake-task-A",
      ci: "1",
      term: "dumb",
    });
  });

  it.each<{ name: string; names: unknown }>([
    { name: "missing", names: undefined },
    { name: "empty", names: [] },
  ])("refuses $name credential-name configuration before exposing a launcher", ({ names }) => {
    expect(createChildProcessLauncher(names as readonly string[])).toMatchObject({
      ok: false,
      code: "INVALID_CONFIGURATION",
      field: "credentialEnvVars",
    });
  });

  it("closes standard input so the child observes EOF", async () => {
    const configured = createChildProcessLauncher(["CDA68_PROVIDER_KEY"]);
    if (!configured.ok) throw new Error(configured.message);

    const result = await readChild(
      configured.launcher.launch([
        process.execPath,
        "--no-env-file",
        "-e",
        "console.log(JSON.stringify(await new Response(Bun.stdin.stream()).text()));",
      ]),
    );

    expect(result).toEqual({ exitCode: 0, stdout: '""\n', stderr: "" });
  });
});
