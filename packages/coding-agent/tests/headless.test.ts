import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { type HeadlessResult, runHeadless } from "../src/headless.ts";
import { NAMED_TASK_FILE, NAMED_TASK_REPO, READ_ONLY_RUN } from "./support/named-task.ts";
import { withTemporaryDirectory } from "./support/process.ts";
import {
  type Respond,
  replayInOrder,
  type SentRequest,
  withProvider,
} from "./support/recorded-provider.ts";

const secret = "sk-test-credential-value";

const readOnlyRun = READ_ONLY_RUN.fixtures;

interface Run {
  readonly result: HeadlessResult;
  readonly stdout: string;
  readonly stderr: string;
  readonly sent: readonly SentRequest[];
  readonly repoRoot: string;
  readonly outputDir: string;
}

interface Scenario {
  readonly env?: Record<string, string>;
  readonly prepare?: (repoRoot: string) => Promise<void>;
  readonly stdout?: (text: string) => void;
}

async function runNamedTask(
  respond: Respond,
  inspect: (run: Run) => void | Promise<void>,
  { env = {}, prepare, stdout }: Scenario = {},
): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    const repoRoot = join(await realpath(directory), "repo");
    await cp(NAMED_TASK_REPO, repoRoot, { recursive: true });
    await prepare?.(repoRoot);
    const outputDir = join(directory, "out");
    const output = { stdout: "", stderr: "" };
    await withProvider(respond, async (sent) => {
      const result = await runHeadless({
        args: {
          taskFile: NAMED_TASK_FILE,
          provider: READ_ONLY_RUN.provider,
          model: READ_ONLY_RUN.model,
          approvalPolicy: "auto-approve",
          outputDir,
          profile: "default",
          repoRoot,
        },
        cwd: directory,
        env: { GOOGLE_API_KEY: secret, ...env },
        stdout:
          stdout ??
          ((text) => {
            output.stdout += text;
          }),
        stderr: (text) => {
          output.stderr += text;
        },
      });
      await inspect({ result, ...output, sent, repoRoot, outputDir });
    });
  });
}

function toolResponses(request: SentRequest | undefined): unknown[] {
  const body = request?.body as
    | { contents: { parts: { functionResponse?: { response: unknown } }[] }[] }
    | undefined;
  return (body?.contents ?? []).flatMap(({ parts }) =>
    parts.flatMap(({ functionResponse }) => (functionResponse ? [functionResponse.response] : [])),
  );
}

describe("a headless run of the named task on Google", () => {
  it("settles succeeded and exits 0 after a real read of the fixture repository", async () => {
    await runNamedTask(replayInOrder(readOnlyRun), ({ result, sent, repoRoot }) => {
      expect(result.exitCode).toBe(0);
      expect(result.result?.outcome).toBe("succeeded");

      expect(sent).toHaveLength(3);
      expect(toolResponses(sent[1])).toEqual([
        {
          output:
            `${JSON.stringify(join(repoRoot, "src", "slugify.ts"))} (lines 1-3 of 3)\n` +
            "1 | export function slugify(title: string): string {\n" +
            '2 |   return title.trim().toLowerCase().replace(/\\s+/g, "-");\n' +
            "3 | }",
        },
      ]);
      expect(toolResponses(sent[2]).at(-1)).toEqual({
        error: '"src/slugify.test.ts" does not exist',
      });
    });
  });

  it("offers the model read as its only tool, with the Project Instructions in the prompt", async () => {
    await runNamedTask(replayInOrder(readOnlyRun), async ({ sent }) => {
      const body = sent[0]?.body as {
        tools: { function_declarations: { name: string }[] }[];
        system_instruction: { parts: { text: string }[] };
      };
      expect(
        body.tools.flatMap((tool) => tool.function_declarations.map(({ name }) => name)),
      ).toEqual(["read"]);
      const instructions = await Bun.file(join(NAMED_TASK_REPO, "AGENTS.md")).text();
      expect(body.system_instruction.parts[0]?.text).toContain(instructions);
    });
  });

  it("prints the final message and reports that the workspace did not change", async () => {
    await runNamedTask(replayInOrder(readOnlyRun), ({ result, stdout, stderr }) => {
      expect(result.result?.workspaceChanged).toBe(false);
      expect(stdout).toStartWith("I have read `src/slugify.ts`. \n\nSince only the `read` tool is");
      expect(stdout).toEndWith("show me the test failing so I can proceed to step 2!\n");
      expect(stderr).toBe("coding-agent: succeeded; workspace changed: no\n");
    });
  });

  it("exits 1 and names the failure when the provider rejects the request", async () => {
    const reject = () => new Response('{"error":{"message":"quota exhausted"}}', { status: 400 });
    await runNamedTask(reject, ({ result, stdout, stderr }) => {
      expect(result.exitCode).toBe(1);
      expect(result.result?.outcome).toBe("failed");
      expect(stdout).toBe("");
      expect(stderr).toStartWith("coding-agent: failed; workspace changed: no\n");
      expect(stderr).toContain("coding-agent: MODEL_FAILURE: ");
      expect(stderr).toContain("quota exhausted");
    });
  });

  it("prints no credential, even when the model and the provider echo it back", async () => {
    const echoInText: Respond = ({ headers }) =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: `key ${headers.get("x-goog-api-key")}` }], role: "model" },
              finishReason: "STOP",
            },
          ],
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    await runNamedTask(echoInText, ({ result, stdout, stderr }) => {
      expect(result.exitCode).toBe(0);
      expect(stdout).toBe("key [redacted]\n");
      expect(stderr).not.toContain(secret);
    });

    const echoInError: Respond = ({ headers }) =>
      new Response(`bad key ${headers.get("x-goog-api-key")}`, { status: 400 });
    await runNamedTask(echoInError, ({ result, stdout, stderr }) => {
      expect(result.exitCode).toBe(1);
      expect(stderr).toContain("bad key [redacted]");
      expect(stdout + stderr).not.toContain(secret);
    });
  });

  it("keeps the exit code of the Agent Result when printing fails", async () => {
    await runNamedTask(
      replayInOrder(readOnlyRun),
      ({ result, stderr }) => {
        expect(result.exitCode).toBe(0);
        expect(result.result?.outcome).toBe("succeeded");
        expect(stderr).toBe("coding-agent: succeeded; workspace changed: no\n");
      },
      {
        stdout: () => {
          throw new Error("the reader has gone");
        },
      },
    );
  });

  it("says which Project Instructions candidate it passed over", async () => {
    await runNamedTask(
      replayInOrder(readOnlyRun),
      ({ result, stderr }) => {
        expect(result.exitCode).toBe(0);
        expect(stderr).toBe(
          'coding-agent: Project Instructions candidate AGENTS.md skipped: "AGENTS.md" is empty\n' +
            "coding-agent: succeeded; workspace changed: no\n",
        );
      },
      { prepare: (repoRoot) => Bun.write(join(repoRoot, "AGENTS.md"), "").then(() => undefined) },
    );
  });

  // Temporary: CDA-80 (D5) runs the configured command through the Verification Policy.
  it("exits 70 without a Model Turn rather than skip a configured verification command", async () => {
    await runNamedTask(
      replayInOrder(readOnlyRun),
      ({ result, stdout, stderr, sent, outputDir }) => {
        expect(result).toEqual({ exitCode: 70 });
        expect(sent).toHaveLength(0);
        expect(stdout).toBe("");
        expect(stderr).toBe(
          "coding-agent: CODING_AGENT_VERIFICATION_COMMAND is set, but no verification command " +
            "runs yet; CDA-80 (D5) wires in the Verification Policy\n",
        );
        expect(existsSync(outputDir)).toBe(false);
      },
      { env: { CODING_AGENT_VERIFICATION_COMMAND: "bun test" } },
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "exits 2 without a Model Turn when the Project Instructions cannot be read",
    async () => {
      await runNamedTask(
        replayInOrder(readOnlyRun),
        ({ result, stdout, stderr, sent, outputDir }) => {
          expect(result).toEqual({ exitCode: 2 });
          expect(sent).toHaveLength(0);
          expect(stdout).toBe("");
          expect(stderr).toBe(
            "coding-agent: the Project Instructions file AGENTS.md cannot be read: permission denied\n",
          );
          expect(existsSync(outputDir)).toBe(false);
        },
        {
          prepare: (repoRoot) => chmod(join(repoRoot, "AGENTS.md"), 0o000),
          // A configuration error wins over a setting that is not built yet.
          env: { CODING_AGENT_VERIFICATION_COMMAND: "bun test" },
        },
      );
    },
  );
});
