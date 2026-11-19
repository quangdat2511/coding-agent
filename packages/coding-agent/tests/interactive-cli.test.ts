import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { READ_ONLY_RUN } from "./support/named-task.ts";
import { noPseudoTerminal, onWindows } from "./support/platform.ts";
import {
  bunLikeShebang,
  firstLine,
  runProcess,
  withTemporaryDirectory,
} from "./support/process.ts";

// Smoke tests of the entry point on the interactive path. A test runner has no terminal, so what
// they can show is every refusal before the TUI takes the screen; the session itself is covered in
// interactive.test.ts, against a TUI that records what it is given.

const packageRoot = join(import.meta.dir, "..");
const bin = join(packageRoot, "src", "cli.ts");

// Windows cannot start a file by its shebang, so there the bin runs under this Bun.
const command = onWindows ? [...bunLikeShebang, bin] : [bin];

const secret = "sk-test-credential-value";

const provider = ["--provider", READ_ONLY_RUN.provider, "--model", READ_ONLY_RUN.model];

const run = (args: readonly string[], env: Record<string, string> = {}) =>
  withTemporaryDirectory((cwd) => runProcess([...command, ...args], { cwd, env }));

describe("the coding-agent executable on the interactive path", () => {
  it("exits 2 with the usage of both entry points when it is given nothing", async () => {
    const { exitCode, stdout, stderr } = await run([]);

    expect(exitCode).toBe(2);
    expect(firstLine(stderr)).toBe("coding-agent: --provider is required");
    expect(stderr).toContain("usage: coding-agent --provider");
    expect(stderr).toContain("usage: coding-agent run");
    expect(stdout).toBe("");
  });

  it.each([
    {
      name: "a missing --model",
      args: ["--provider", "google"],
      expected: "--model is required",
    },
    {
      name: "an unknown provider",
      args: ["--provider", "mistral", "--model", "m"],
      expected:
        '--provider must be one of anthropic, openrouter, openai, google, xai, opencode, not "mistral"',
    },
    {
      name: "--approval-policy, which the interactive path does not take",
      args: [...provider, "--approval-policy", "ask"],
      expected: 'unknown flag "--approval-policy"',
    },
    {
      name: "--task-file, which belongs to coding-agent run",
      args: [...provider, "--task-file", "task.md"],
      expected: 'unknown flag "--task-file"',
    },
    {
      name: "a bare word that is no command",
      args: ["serve"],
      expected: 'unknown command "serve"',
    },
  ])("exits 2 and writes a usage message on $name", async ({ args, expected }) => {
    const { exitCode, stdout, stderr } = await run(args, { GOOGLE_API_KEY: secret });

    expect(exitCode).toBe(2);
    expect(firstLine(stderr)).toBe(`coding-agent: ${expected}`);
    expect(stderr).toContain("usage: coding-agent");
    expect(stdout).toBe("");
  });

  it("exits 2 on an unknown model before it takes the screen", async () => {
    const { exitCode, stdout, stderr } = await run(
      ["--provider", "google", "--model", "no-such-model"],
      { GOOGLE_API_KEY: secret },
    );

    expect(exitCode).toBe(2);
    expect(stderr).toBe('coding-agent: --model "no-such-model" is not a known google model\n');
    expect(stdout).toBe("");
  });

  it("exits 2 when the provider credential is missing", async () => {
    const { exitCode, stdout, stderr } = await run(provider);

    expect(exitCode).toBe(2);
    expect(firstLine(stderr)).toStartWith("coding-agent: no credential for --provider google");
    expect(stdout).toBe("");
  });

  it("exits 2 and points to coding-agent run when its output is not a terminal", async () => {
    const { exitCode, stdout, stderr } = await run(provider, { GOOGLE_API_KEY: secret });

    expect(exitCode).toBe(2);
    expect(firstLine(stderr)).toContain("needs a terminal");
    expect(firstLine(stderr)).toContain("coding-agent run");
    expect(stdout).toBe("");
    expect(stderr).not.toContain(secret);
  });

  // The one test that gives the TUI a real terminal, so it runs only where Bun can open one. It
  // needs no provider: the TUI has to take the screen, and two presses of the cancel key quit.
  it.skipIf(noPseudoTerminal)(
    "takes the screen on a terminal and quits on two cancel keys",
    async () => {
      await withTemporaryDirectory(async (cwd) => {
        let output = "";
        const decoder = new TextDecoder();
        const child = Bun.spawn([...command, ...provider], {
          cwd,
          env: { PATH: process.env.PATH ?? "", GOOGLE_API_KEY: secret },
          terminal: {
            cols: 100,
            rows: 30,
            data(_terminal: unknown, data: Uint8Array) {
              output += decoder.decode(data, { stream: true });
            },
          },
        } as Parameters<typeof Bun.spawn>[1]);
        let exitCode: number | null = null;
        void child.exited.then((code) => {
          exitCode = code;
        });

        const altScreen = "\u001b[?1049h";
        // What the screen shows, without the escape sequences that move the cursor or style text.
        const screen = () =>
          output
            .split("\u001b")
            .map((part, index) =>
              index === 0 ? part : part.replace(/^\[[0-9;?<>=]*[ -/]*[@-~]/, ""),
            )
            .join("");
        const failure = (what: string) =>
          new Error(
            `${what} (exit code ${exitCode}); the screen showed:\n${screen().slice(-2_000)}`,
          );
        // Waits until `done`, and fails early if the TUI has ended by then.
        const waitUntil = async (done: () => boolean, ms: number, what: string) => {
          for (const end = Date.now() + ms; !done(); await Bun.sleep(20)) {
            if (exitCode !== null) throw failure(`the TUI ended before ${what}`);
            if (Date.now() > end) throw failure(`no ${what} within ${ms} ms`);
          }
        };
        // A press after the TUI has quit finds the terminal closed, which is no failure of the test.
        const press = () => {
          try {
            (child as unknown as { terminal: { write(key: string): void } }).terminal.write(
              "\u0003",
            );
          } catch {}
        };
        const noticeShown = () => screen().includes("Press Esc or Ctrl+C again");

        // Until Ink puts the terminal in raw mode, the terminal turns Ctrl+C into SIGINT, which
        // ends the run with 130 before the TUI can read the key. So no key is pressed before the
        // first frame, with the footer under the Prompt, is on the screen, and a moment after it.
        await waitUntil(
          () => output.includes(altScreen) && screen().includes("Esc/Ctrl+C cancel"),
          15_000,
          "first frame",
        );
        await Bun.sleep(500);

        press();
        await waitUntil(noticeShown, 5_000, "notice after the first cancel key");
        // The notice came right after the first press, so this one is within the quit window.
        press();

        expect(await child.exited).toBe(0);
      });
    },
    30_000,
  );

  it("keeps the headless command line as it was", async () => {
    const { exitCode, stderr } = await run(["run", "--approval-policy", "ask"]);

    expect(exitCode).toBe(2);
    expect(firstLine(stderr)).toBe("coding-agent: --task-file is required");
  });
});
