import { describe, expect, it } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_CREDENTIAL_ENV_VARS } from "@coding-agent/ai";
import { bashTool, createWorkspaceResolver } from "@coding-agent/tools";
import { createConfiguredChildLauncher } from "../src/child-launcher.ts";

describe("configuring the child launcher in the composition root", () => {
  it("removes all six MVP credential names while preserving variables outside that set", async () => {
    const fixture = {
      ANTHROPIC_API_KEY: "fake-anthropic",
      GOOGLE_API_KEY: "fake-google",
      GEMINI_API_KEY: "fake-gemini",
      OPENAI_API_KEY: "fake-openai",
      OPENROUTER_API_KEY: "fake-openrouter",
      XAI_API_KEY: "fake-xai",
      GH_TOKEN: "fake-task-token",
      GOOGLE_API_KEY_BACKUP: "task-owned-backup",
      // ADR 0001 §8's MVP credential residual: OpenCode is not CLI-selectable, so it is inherited.
      OPENCODE_API_KEY: "outside-the-mvp-set",
    };
    const saved = Object.fromEntries(Object.keys(fixture).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, fixture);
      const configured = createConfiguredChildLauncher();
      if (!configured.ok) throw new Error(configured.message);

      const child = configured.launcher.launch([
        process.execPath,
        "--no-env-file",
        "-e",
        `console.log(JSON.stringify({
          anthropic: process.env.ANTHROPIC_API_KEY ?? null,
          google: process.env.GOOGLE_API_KEY ?? null,
          gemini: process.env.GEMINI_API_KEY ?? null,
          openai: process.env.OPENAI_API_KEY ?? null,
          openrouter: process.env.OPENROUTER_API_KEY ?? null,
          xai: process.env.XAI_API_KEY ?? null,
          taskToken: process.env.GH_TOKEN,
          backup: process.env.GOOGLE_API_KEY_BACKUP,
          opencode: process.env.OPENCODE_API_KEY,
        }));`,
      ]);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect({ exitCode, environment: JSON.parse(stdout), stderr }).toEqual({
        exitCode: 0,
        environment: {
          anthropic: null,
          google: null,
          gemini: null,
          openai: null,
          openrouter: null,
          xai: null,
          taskToken: "fake-task-token",
          backup: "task-owned-backup",
          opencode: "outside-the-mvp-set",
        },
        stderr: "",
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("running bash through the configured launcher", () => {
  it("cannot read any provider credential, while a variable the task set stays visible", async () => {
    const credentials = Object.fromEntries(
      PROVIDER_CREDENTIAL_ENV_VARS.map((name) => [name, `fake-${name.toLowerCase()}`]),
    );
    const fixture = { ...credentials, CDA71_TASK_VAR: "visible-to-the-task" };
    const saved = Object.fromEntries(Object.keys(fixture).map((key) => [key, process.env[key]]));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "bash-credentials-")));
    try {
      Object.assign(process.env, fixture);
      const configured = createConfiguredChildLauncher();
      if (!configured.ok) throw new Error(configured.message);
      const created = await createWorkspaceResolver(repo);
      if (!created.ok) throw new Error(created.message);
      const ctx = {
        workspace: created.workspace,
        signal: new AbortController().signal,
        onProgress: () => {},
      };
      const tool = bashTool(configured.launcher);
      // printenv prints nothing and fails for a variable the child does not have.
      const names = [...PROVIDER_CREDENTIAL_ENV_VARS, "CDA71_TASK_VAR"];
      const command = names.map((name) => `echo "${name}=$(printenv ${name} || echo absent)"`);
      const prepared = await tool.prepare({ command: command.join("\n") }, ctx);
      if (!prepared.ok) throw new Error(prepared.message);

      const outcome = await tool.execute(prepared.prepared, ctx);

      expect(PROVIDER_CREDENTIAL_ENV_VARS.length).toBeGreaterThan(0);
      expect(outcome.content).toBe(
        [
          ...PROVIDER_CREDENTIAL_ENV_VARS.map((name) => `${name}=absent`),
          "CDA71_TASK_VAR=visible-to-the-task",
          "[exit code: 0]",
        ].join("\n"),
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(repo, { recursive: true, force: true });
    }
  });
});
