import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { type HeadlessResult, runHeadless } from "../src/headless.ts";
import { NAMED_TASK_FILE, NAMED_TASK_REPO, READ_ONLY_RUN } from "./support/named-task.ts";
import { noFullDevice } from "./support/platform.ts";
import { withTemporaryDirectory } from "./support/process.ts";
import {
  type Respond,
  replayInOrder,
  type SentRequest,
  withProvider,
} from "./support/recorded-provider.ts";

const secret = "sk-test-credential-value";

const readOnlyRun = READ_ONLY_RUN.fixtures;

const deep = { recursive: true } as const;

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
  readonly prepare?: (repoRoot: string, outputDir: string) => Promise<unknown>;
  readonly stdout?: (text: string) => void;
  readonly onRequest?: (outputDir: string, sent: readonly SentRequest[]) => void | Promise<void>;
}

async function runNamedTask(
  respond: Respond,
  inspect: (run: Run) => void | Promise<void>,
  { env = {}, prepare, stdout, onRequest }: Scenario = {},
): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    const repoRoot = join(await realpath(directory), "repo");
    await cp(NAMED_TASK_REPO, repoRoot, { recursive: true });
    const outputDir = join(directory, "out");
    await prepare?.(repoRoot, outputDir);
    const output = { stdout: "", stderr: "" };
    const requests: SentRequest[] = [];
    const observed: Respond = async (request) => {
      requests.push(request);
      await onRequest?.(outputDir, requests);
      return respond(request);
    };
    await withProvider(observed, async (sent) => {
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

interface LoggedEvent {
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

// A line still being written has no newline yet, so only the lines before the last one count.
async function loggedEvents(outputDir: string): Promise<LoggedEvent[]> {
  const text = await Bun.file(join(outputDir, "events.jsonl")).text();
  return text
    .split("\n")
    .slice(0, -1)
    .map((line) => JSON.parse(line));
}

async function writtenText(outputDir: string): Promise<string> {
  const names = ["run.json", "events.jsonl", "result.json"];
  const texts = await Promise.all(names.map((name) => Bun.file(join(outputDir, name)).text()));
  return texts.join("");
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

  it("writes run.json before the first Model Turn, with what reproduces the run", async () => {
    const existedAtFirstRequest: boolean[] = [];
    await runNamedTask(
      replayInOrder(readOnlyRun),
      async ({ sent, repoRoot, outputDir }) => {
        expect(existedAtFirstRequest[0]).toBe(true);
        const systemInstruction = sent[0]?.body.system_instruction as {
          parts: { text: string }[];
        };
        expect(await Bun.file(join(outputDir, "run.json")).json()).toEqual({
          schemaVersion: 1,
          codingAgent: { version: "0.0.1", commit: null },
          provider: "google",
          model: "gemini-3.5-flash-lite",
          sampling: { maxOutputTokens: null, temperature: null },
          transportRetryBound: 2,
          repoRoot,
          profile: "default",
          limits: {
            maxModelTurns: 30,
            maxToolCalls: 100,
            maxDurationMs: 600_000,
            maxConsecutiveRecoverableFailures: 3,
            cancellationGraceMs: 5_000,
          },
          approvalPolicy: "auto-approve",
          verification: { command: null },
          tools: ["read"],
          systemPrompt: systemInstruction.parts[0]?.text,
        });
      },
      {
        onRequest: (outputDir) => {
          existedAtFirstRequest.push(existsSync(join(outputDir, "run.json")));
        },
      },
    );
  });

  it("logs one Session Event per line, without deltas and with their sequence numbers", async () => {
    await runNamedTask(replayInOrder(readOnlyRun), async ({ result, outputDir }) => {
      const text = await Bun.file(join(outputDir, "events.jsonl")).text();
      expect(text).toEndWith("\n");
      const events = await loggedEvents(outputDir);
      const types = events.map(({ type }) => type);
      const sequences = events.map(({ sequence }) => sequence);

      expect(events.every(({ schemaVersion }) => schemaVersion === 1)).toBe(true);
      expect(new Set(events.map(({ sessionId }) => sessionId)).size).toBe(1);
      expect(types).not.toContain("assistant_content_delta");
      expect(types).toContain("assistant_message_completed");
      expect(types).toContain("tool_call_completed");
      expect(types).toContain("verification_completed");

      expect(events[0]).toMatchObject({
        sequence: 1,
        type: "session_started",
        data: { task: { objective: await Bun.file(NAMED_TASK_FILE).text() } },
      });
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);
      // The final message streamed as deltas, which are left out, so their numbers are missing.
      expect(sequences.length).toBeLessThan(sequences.at(-1) ?? 0);
      expect(events.at(-1)).toMatchObject({
        sequence: result.result?.lastSequence,
        type: "session_settled",
        data: { result: JSON.parse(JSON.stringify(result.result)) },
      });
    });
  });

  it("appends events while the run goes on, so a killed run keeps what was written", async () => {
    const atSecondRequest: { types: string[]; readError?: string } = { types: [] };
    await runNamedTask(
      replayInOrder(readOnlyRun),
      () => {
        expect(atSecondRequest.readError).toBeUndefined();
        expect(atSecondRequest.types).toContain("tool_call_completed");
        expect(atSecondRequest.types).not.toContain("session_settled");
      },
      {
        onRequest: async (outputDir, sent) => {
          if (sent.length !== 2) return;
          // The log is written behind the Agent Session, so give it a moment to catch up.
          for (let attempt = 0; attempt < 200; attempt++) {
            try {
              const types = (await loggedEvents(outputDir)).map(({ type }) => type);
              if (types.includes("tool_call_completed")) {
                atSecondRequest.types = types;
                delete atSecondRequest.readError;
                return;
              }
            } catch (error) {
              atSecondRequest.readError = String(error);
            }
            await Bun.sleep(10);
          }
        },
      },
    );
  });

  it("writes result.json with the exit code, the Agent Result and the finish time", async () => {
    const startedAt = Date.now();
    await runNamedTask(replayInOrder(readOnlyRun), async ({ result, outputDir }) => {
      const written = await Bun.file(join(outputDir, "result.json")).json();
      expect(written).toEqual({
        schemaVersion: 1,
        exitCode: 0,
        result: JSON.parse(JSON.stringify(result.result)),
        finishedAt: expect.any(String),
      });
      expect(written.result.outcome).toBe("succeeded");
      expect(new Date(written.finishedAt).toISOString()).toBe(written.finishedAt);
      const finishedAt = Date.parse(written.finishedAt);
      expect(finishedAt).toBeGreaterThanOrEqual(startedAt);
      expect(finishedAt).toBeLessThanOrEqual(Date.now());
    });
  });

  it("writes all three files for a failed run, with exit code 1 in result.json", async () => {
    const reject = () => new Response('{"error":{"message":"quota exhausted"}}', { status: 400 });
    await runNamedTask(reject, async ({ result, outputDir }) => {
      expect(result.exitCode).toBe(1);
      expect((await readdir(outputDir)).sort()).toEqual([
        "events.jsonl",
        "result.json",
        "run.json",
      ]);
      const written = await Bun.file(join(outputDir, "result.json")).json();
      expect(written).toMatchObject({
        schemaVersion: 1,
        exitCode: 1,
        result: { outcome: "failed", failure: { code: "MODEL_FAILURE" } },
      });
      expect((await loggedEvents(outputDir)).at(-1)).toMatchObject({
        type: "session_settled",
        data: { result: { outcome: "failed" } },
      });
    });
  });

  it("writes no credential, even when the repository, the model and the provider hold it", async () => {
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
    await runNamedTask(
      echoInText,
      async ({ result, outputDir }) => {
        expect(result.exitCode).toBe(0);
        const run = await Bun.file(join(outputDir, "run.json")).json();
        expect(run.systemPrompt).toContain("Use the key [redacted] when asked.");
        const written = await writtenText(outputDir);
        expect(written).toContain("key [redacted]");
        expect(written).not.toContain(secret);
      },
      {
        prepare: (repoRoot) =>
          Bun.write(join(repoRoot, "AGENTS.md"), `Use the key ${secret} when asked.\n`).then(
            () => undefined,
          ),
      },
    );

    const echoInError: Respond = ({ headers }) =>
      new Response(`bad key ${headers.get("x-goog-api-key")}`, { status: 400 });
    await runNamedTask(echoInError, async ({ result, outputDir }) => {
      expect(result.exitCode).toBe(1);
      const written = await writtenText(outputDir);
      expect(written).toContain("bad key [redacted]");
      expect(written).not.toContain(secret);
    });
  });

  it("exits 70 before the first Model Turn when run.json cannot be written", async () => {
    await runNamedTask(
      replayInOrder(readOnlyRun),
      async ({ result, stdout, stderr, sent, outputDir }) => {
        expect(result).toEqual({ exitCode: 70 });
        expect(sent).toHaveLength(0);
        expect(stdout).toBe("");
        expect(stderr).toStartWith("coding-agent: internal error: ");
        expect(await readdir(outputDir)).toEqual(["run.json"]);
      },
      { prepare: (_repoRoot, outputDir) => mkdir(join(outputDir, "run.json", "taken"), deep) },
    );
  });

  it("exits 70 before the first Model Turn and keeps no run.json when the log cannot be opened", async () => {
    await runNamedTask(
      replayInOrder(readOnlyRun),
      async ({ result, stdout, stderr, sent, outputDir }) => {
        expect(result).toEqual({ exitCode: 70 });
        expect(sent).toHaveLength(0);
        expect(stdout).toBe("");
        expect(stderr).toStartWith("coding-agent: internal error: ");
        expect(await readdir(outputDir)).toEqual(["events.jsonl"]);
      },
      { prepare: (_repoRoot, outputDir) => mkdir(join(outputDir, "events.jsonl"), deep) },
    );
  });

  it.skipIf(noFullDevice)(
    "still writes result.json and prints the outcome when the log fails during the task",
    async () => {
      await runNamedTask(
        replayInOrder(readOnlyRun),
        async ({ result, stdout, stderr, outputDir }) => {
          expect(result.exitCode).toBe(70);
          expect(result.result?.outcome).toBe("succeeded");
          expect(stdout).not.toBe("");
          expect(stderr).toContain("coding-agent: succeeded; workspace changed: no\n");
          expect(stderr).toContain("coding-agent: internal error: ");
          const written = await Bun.file(join(outputDir, "result.json")).json();
          expect(written).toMatchObject({ exitCode: 70, result: { outcome: "succeeded" } });
        },
        {
          prepare: async (_repoRoot, outputDir) => {
            await mkdir(outputDir, deep);
            await symlink("/dev/full", join(outputDir, "events.jsonl"));
          },
        },
      );
    },
  );

  it("exits 70 and still prints the outcome when result.json cannot be written", async () => {
    await runNamedTask(
      replayInOrder(readOnlyRun),
      async ({ result, stdout, stderr, outputDir }) => {
        expect(result.exitCode).toBe(70);
        expect(result.result?.outcome).toBe("succeeded");
        expect(stdout).not.toBe("");
        expect(stderr).toContain("coding-agent: succeeded; workspace changed: no\n");
        expect(stderr).toContain("coding-agent: internal error: ");
        expect((await loggedEvents(outputDir)).at(-1)?.type).toBe("session_settled");
        expect((await readdir(outputDir)).sort()).toEqual([
          "events.jsonl",
          "result.json",
          "run.json",
        ]);
        expect(await readdir(join(outputDir, "result.json"))).toEqual(["taken"]);
      },
      {
        onRequest: async (outputDir, sent) => {
          if (sent.length === 1) await mkdir(join(outputDir, "result.json", "taken"), deep);
        },
      },
    );
  });

  it("leaves nothing of an earlier run in the output directory once the task starts", async () => {
    const atFirstRequest: { result: boolean; events: string }[] = [];
    await runNamedTask(
      replayInOrder(readOnlyRun),
      async ({ outputDir }) => {
        expect(atFirstRequest[0]?.result).toBe(false);
        expect(atFirstRequest[0]?.events).not.toContain("earlier");
        expect(await writtenText(outputDir)).not.toContain("earlier");
      },
      {
        prepare: async (_repoRoot, outputDir) => {
          for (const name of ["run.json", "events.jsonl", "result.json"]) {
            await Bun.write(join(outputDir, name), '{"from":"earlier"}\n');
          }
        },
        onRequest: async (outputDir, sent) => {
          if (sent.length !== 1) return;
          atFirstRequest.push({
            result: existsSync(join(outputDir, "result.json")),
            events: await Bun.file(join(outputDir, "events.jsonl")).text(),
          });
        },
      },
    );
  });
});
