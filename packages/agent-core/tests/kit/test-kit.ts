import type {
  ApprovalPolicy,
  ExecutableTool,
  OpenSessionConfig,
  SessionLimits,
  VerificationDecision,
  WorkspaceResolver,
} from "../../src/index.ts";
import { type ManualClock, manualClock } from "./clock.ts";
import { sequentialIds } from "./ids.ts";
import { type FakeModel, fakeModel, type ScriptedTurn } from "./model.ts";
import { fakeTool, toolRegistry } from "./tools.ts";
import { type FakeVerification, fakeVerification } from "./verification.ts";
import { fakeWorkspace } from "./workspace.ts";

export interface TestKitOptions {
  readonly turns?: readonly ScriptedTurn[];
  readonly tools?: readonly ExecutableTool[];
  readonly workspace?: WorkspaceResolver;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly verification?: readonly VerificationDecision[];
  readonly limits?: Partial<SessionLimits>;
}

export interface TestKit {
  readonly config: OpenSessionConfig;
  readonly model: FakeModel;
  readonly verification: FakeVerification;
  readonly clock: ManualClock;
  readonly portCalls: readonly string[];
}

export const testLimits: SessionLimits = {
  maxModelTurns: 30,
  maxToolCalls: 100,
  maxDurationMs: 600_000,
  maxConsecutiveRecoverableFailures: 3,
  cancellationGraceMs: 2_000,
};

export function createTestKit(options: TestKitOptions = {}): TestKit {
  const portCalls: string[] = [];
  const record = <T>(call: string, effect: () => T): T => {
    portCalls.push(call);
    return effect();
  };

  const model = fakeModel(options.turns);
  const verification = fakeVerification(options.verification);
  const workspace = options.workspace ?? fakeWorkspace();
  const clock = manualClock();
  const ids = sequentialIds();
  const tools = (options.tools ?? [fakeTool()]).map(
    (tool): ExecutableTool => ({
      ...tool,
      prepare: (input, ctx) => record(`tool.${tool.name}.prepare`, () => tool.prepare(input, ctx)),
      execute: (prepared, ctx) =>
        record(`tool.${tool.name}.execute`, () => tool.execute(prepared, ctx)),
    }),
  );

  return {
    model,
    verification,
    clock,
    portCalls,
    config: {
      model: {
        identity: model.identity,
        capabilities: model.capabilities,
        stream: (context, request) => record("model.stream", () => model.stream(context, request)),
      },
      systemPrompt: "You are a coding agent.",
      tools: toolRegistry(...tools),
      workspace: {
        repoRoot: workspace.repoRoot,
        resolveExisting: (input) =>
          record(`workspace.resolveExisting ${input}`, () => workspace.resolveExisting(input)),
        resolveForCreate: (input) =>
          record(`workspace.resolveForCreate ${input}`, () => workspace.resolveForCreate(input)),
      },
      approvalPolicy: options.approvalPolicy ?? "ask",
      verification: {
        verify: (candidate, ctx) =>
          record("verification.verify", () => verification.verify(candidate, ctx)),
      },
      limits: { ...testLimits, ...options.limits },
      clock: {
        now: () => record("clock.now", clock.now),
        monotonicMs: () => record("clock.monotonicMs", clock.monotonicMs),
      },
      ids: { next: (kind) => record(`ids.next ${kind}`, () => ids.next(kind)) },
    },
  };
}
