import type { ApprovalDecision, ApprovalRequest, SessionEvent, Summary } from "./events.ts";

class Cancelled extends Error {}

const TASK =
  "Add a --json flag to the provider registry so `coding-agent providers` can be piped into jq, " +
  "and cover it with a test.";

const TURN_1 =
  "I'll look at how the provider registry is assembled before touching anything. The flag belongs " +
  "at the CLI boundary rather than inside @coding-agent/ai, so the registry stays presentation-free " +
  "and the AI context keeps its provider-neutral shape.\n\n";

const TURN_2 =
  "The registry exposes a flat record keyed by provider id, and every entry already carries the " +
  "fields a machine-readable listing needs: id, display name, base URL and the env var it " +
  "authenticates with. So no new data has to be threaded through. I'll add a serializer next to " +
  "the registry that projects each entry into a stable shape, then have the CLI pick between the " +
  "table formatter and JSON.stringify on that projection. A test pins the key set so a later " +
  "provider addition cannot silently change the contract.\n\n";

const RECOVERY =
  "Understood, leaving all.ts alone. The projection can live entirely in the CLI layer instead, " +
  "which keeps @coding-agent/ai untouched at the cost of the CLI knowing the entry shape.\n\n";

const READ_OUTPUT = [
  'import { anthropic } from "@/providers/anthropic";',
  'import { google } from "@/providers/google";',
  'import { openai } from "@/providers/openai";',
  'import { openrouter } from "@/providers/openrouter";',
  'import { xai } from "@/providers/xai";',
  'import type { Provider, ProviderId } from "@/types";',
  "",
  "export const providers = {",
  "  anthropic,",
  "  google,",
  "  openai,",
  "  openrouter,",
  "  xai,",
  "} as const satisfies Record<ProviderId, Provider>;",
  "",
  "export function getProvider(id: ProviderId): Provider {",
  "  const provider = providers[id];",
  "  if (!provider) {",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: sample file content, not a template
  "    throw new Error(`Unknown provider: ${id}`);",
  "  }",
  "  return provider;",
  "}",
  "",
  "export function listProviders(): Provider[] {",
  "  return Object.values(providers);",
  "}",
  "",
  "export function resolveProviderFromEnv(env: Record<string, string | undefined>): Provider {",
  "  const requested = env.AGENT_PROVIDER;",
  "  if (requested) {",
  "    return getProvider(requested as ProviderId);",
  "  }",
  "  for (const provider of listProviders()) {",
  "    if (env[provider.apiKeyEnvVar]) {",
  "      return provider;",
  "    }",
  "  }",
  "  throw new Error(",
  '    "No provider configured. Set AGENT_PROVIDER or one of the *_API_KEY variables.",',
  "  );",
  "}",
];

const GREP_OUTPUT = [
  "packages/ai/src/providers/all.ts:8:export const providers = {",
  "packages/ai/src/index.ts:12:export { providers, getProvider } from `@/providers/all`;",
  "packages/ai/src/auth/helpers.ts:31:  const provider = getProvider(id);",
  "packages/ai/tests/sample.test.ts:4:import { providers } from `@/providers/all`;",
];

const EDIT_DIFF = [
  "--- a/packages/ai/src/providers/all.ts",
  "+++ b/packages/ai/src/providers/all.ts",
  "@@ -24,6 +24,15 @@",
  " export function listProviders(): Provider[] {",
  "   return Object.values(providers);",
  " }",
  "+",
  "+export interface ProviderSummary {",
  "+  id: ProviderId;",
  "+  name: string;",
  "+  baseUrl: string;",
  "+  apiKeyEnvVar: string;",
  "+}",
  "+",
  "+export function summarizeProviders(): ProviderSummary[] {",
  "+  return listProviders().map(({ id, name, baseUrl, apiKeyEnvVar }) => ({",
  "+    id,",
  "+    name,",
  "+    baseUrl,",
  "+    apiKeyEnvVar,",
  "+  }));",
  "+}",
];

const TEST_FILE = [
  'import { describe, expect, test } from "bun:test";',
  'import { summarizeProviders } from "@/providers/all";',
  "",
  'describe("summarizeProviders", () => {',
  '  test("projects a stable key set for every provider", () => {',
  "    for (const summary of summarizeProviders()) {",
  "      expect(Object.keys(summary).sort()).toEqual([",
  '        "apiKeyEnvVar",',
  '        "baseUrl",',
  '        "id",',
  '        "name",',
  "      ]);",
  "    }",
  "  });",
  "});",
];

const BASH_PROGRESS = [
  "bun test v1.3.14 (0d9b296a)",
  "",
  "packages/ai/tests/providers-json.test.ts:",
  "(pass) summarizeProviders > projects a stable key set for every provider [1.82ms]",
  "",
  "packages/ai/tests/event-stream.test.ts:",
  "(pass) EventStream > delivers events to a late subscriber [0.91ms]",
  "(pass) EventStream > replays buffered events in order [0.44ms]",
  "(pass) EventStream > stops delivery after close [0.38ms]",
  "(fail) EventStream > propagates provider errors to subscribers [0.52ms]",
  "",
  "  error: expected 'stream closed' to be 'provider unavailable'",
  "      at packages/ai/tests/event-stream.test.ts:64:5",
  "",
  " 4 pass",
  " 1 fail",
  " 6 expect() calls",
  "Ran 5 tests across 2 files. [412.00ms]",
];

const CHECKS = ["bun --filter '*' typecheck", "biome check .", "bun test"];

export interface SessionOptions {
  charsPerSecond: number;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

export class ScriptedSession {
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private readonly options: SessionOptions;
  private pending: Pending | null = null;
  private wake: (() => void) | null = null;
  private stopped = false;
  private startedAt = 0;
  private tokens = 0;
  private toolCalls = 0;
  private approvals = 0;
  private rejections = 0;
  private checksPassed = 0;
  private checksFailed = 0;
  private alwaysAllow = false;
  private cancelReason = "";
  private readonly filesChanged: string[] = [];

  constructor(options: SessionOptions) {
    this.options = options;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get awaitingApproval(): ApprovalRequest | null {
    return this.pending?.request ?? null;
  }

  decide(decision: ApprovalDecision): boolean {
    const pending = this.pending;
    if (!pending) return false;
    this.pending = null;
    this.emit({ kind: "approval-decided", callId: pending.request.callId, decision });
    pending.resolve(decision);
    return true;
  }

  cancel(reason: string): boolean {
    if (this.stopped) return false;
    this.stopped = true;
    this.cancelReason = reason;
    this.pending?.resolve("reject");
    this.pending = null;
    this.wake?.();
    return true;
  }

  async run(): Promise<void> {
    this.startedAt = Date.now();
    try {
      await this.play();
      this.emit({ kind: "session-settled", summary: this.buildSummary("completed") });
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      this.emit({ kind: "session-cancelled", reason: this.cancelReason });
      this.emit({ kind: "session-settled", summary: this.buildSummary("cancelled") });
    }
  }

  private async play(): Promise<void> {
    this.emit({ kind: "task-started", task: TASK });
    await this.sleep(320);

    this.emit({ kind: "turn-started", turn: 1 });
    await this.stream(TURN_1);

    await this.tool("read", "packages/ai/src/providers/all.ts", "read", READ_OUTPUT, 40);
    await this.tool("grep", '"registerProvider|providers = {"', "read", GREP_OUTPUT, 30);

    this.emit({ kind: "turn-started", turn: 2 });
    await this.stream(TURN_2);

    const editAllowed = await this.tool(
      "edit",
      "packages/ai/src/providers/all.ts",
      "write",
      EDIT_DIFF,
      55,
      {
        question: "Apply this edit to packages/ai/src/providers/all.ts?",
        detail: EDIT_DIFF,
      },
    );

    if (!editAllowed) {
      await this.stream(RECOVERY);
      await this.verify([CHECKS[0] as string, CHECKS[1] as string]);
      return;
    }
    this.filesChanged.push("packages/ai/src/providers/all.ts");

    const testWritten = await this.tool(
      "write",
      "packages/ai/tests/providers-json.test.ts",
      "write",
      TEST_FILE,
      45,
      {
        question: "Create packages/ai/tests/providers-json.test.ts?",
        detail: TEST_FILE,
      },
    );
    if (testWritten) {
      this.filesChanged.push("packages/ai/tests/providers-json.test.ts");
    }

    await this.tool(
      "bash",
      "bun test packages/ai/tests/providers-json.test.ts",
      "execute",
      BASH_PROGRESS,
      260,
      {
        question: "Run `bun test packages/ai/tests/providers-json.test.ts`?",
        detail: ["Working directory: /Users/dang/.../coding-agent", "Timeout: 120s"],
      },
    );

    await this.verify(CHECKS);
  }

  private async tool(
    name: string,
    target: string,
    risk: "read" | "write" | "execute",
    output: string[],
    msPerLine: number,
    gate?: { question: string; detail: string[] },
  ): Promise<boolean> {
    const id = `call-${++this.toolCalls}`;
    this.emit({ kind: "tool-call-started", id, name, target, risk });

    if (gate && !this.alwaysAllow) {
      const decision = await this.requestApproval({
        callId: id,
        question: gate.question,
        risk,
        detail: gate.detail,
      });
      if (decision === "reject") {
        this.rejections += 1;
        this.emit({
          kind: "tool-call-ended",
          id,
          status: "rejected",
          output: ["Rejected by the operator. Nothing was written."],
        });
        return false;
      }
      this.approvals += 1;
      if (decision === "allow-always") {
        this.alwaysAllow = true;
      }
    }

    await this.sleep(180);
    for (const line of output) {
      this.emit({ kind: "tool-call-progress", id, line });
      await this.sleep(msPerLine);
    }
    this.emit({ kind: "tool-call-ended", id, status: "ok", output });
    return true;
  }

  private async verify(checks: string[]): Promise<void> {
    this.emit({ kind: "verification-started", checks });
    const results: Array<[string, "pass" | "fail", string]> = [
      ["bun --filter '*' typecheck", "pass", "0 errors"],
      ["biome check .", "pass", "142 files, 0 diagnostics"],
      ["bun test", "fail", "1 failing: EventStream > propagates provider errors"],
    ];
    for (const check of checks) {
      this.emit({ kind: "verification-progress", check, status: "running" });
      await this.sleep(700);
      const result = results.find(([name]) => name === check);
      const status = result?.[1] ?? "pass";
      if (status === "pass") this.checksPassed += 1;
      else this.checksFailed += 1;
      this.emit({ kind: "verification-progress", check, status, note: result?.[2] });
    }
  }

  private requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    if (this.stopped) return Promise.reject(new Cancelled());
    this.emit({ kind: "approval-requested", request });
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending = { request, resolve };
    }).then((decision) => {
      if (this.stopped) throw new Cancelled();
      return decision;
    });
  }

  private async stream(text: string): Promise<void> {
    const chunk = 3;
    const delay = (chunk / this.options.charsPerSecond) * 1000;
    for (let i = 0; i < text.length; i += chunk) {
      const slice = text.slice(i, i + chunk);
      this.tokens += 1;
      this.emit({ kind: "assistant-delta", text: slice });
      await this.sleep(delay);
    }
    this.emit({ kind: "assistant-ended" });
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.reject(new Cancelled());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null;
        if (this.stopped) reject(new Cancelled());
        else resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        reject(new Cancelled());
      };
    });
  }

  private buildSummary(outcome: "completed" | "cancelled"): Summary {
    return {
      outcome,
      headline:
        outcome === "completed"
          ? this.filesChanged.length > 0
            ? "Provider summary projection added; one pre-existing test still failing."
            : "Edit rejected; no files were changed."
          : `Cancelled: ${this.cancelReason}`,
      filesChanged: [...this.filesChanged],
      toolCalls: this.toolCalls,
      approvals: this.approvals,
      rejections: this.rejections,
      checksPassed: this.checksPassed,
      checksFailed: this.checksFailed,
      elapsedMs: Date.now() - this.startedAt,
      tokens: this.tokens,
    };
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
