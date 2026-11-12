# Promote OpenCode Go to a CLI-Selectable Provider

Status: proposed

Date: 2026-11-12

## Context

[Choose the evaluation provider and model for the recorded TerminalBench job](https://datn-fit-hcmus.atlassian.net/browse/CDA-30)
needs a provider whose spend a student project can carry. Pay-per-use pricing on the five MVP
providers buys a 66-task job for a few dollars, but a subscription gateway amortises repeated jobs:
OpenCode Go is $10 per month and includes $100 of DeepSeek V4.1 Flash usage, which is roughly 38
jobs at the allowance's own list prices, against roughly 7.7 jobs for the same $10 spent
pay-per-use. The project will re-run the job, so that difference is real.

The blocker is not the wire format. `@coding-agent/ai` already speaks the OpenAI Responses API, and
OpenCode Go serves it at `https://opencode.ai/inference/go`, so no new transport is needed. The
blocker is that four accepted records rule the provider out:

- [ADR 0005](./0005-terminalbench-evaluation-protocol.md) §3 closes `--provider` to
  `anthropic | openrouter | openai | google | xai`, and that command line is a versioned external
  contract.
- [ADR 0006](./0006-implementation-order-and-mvp-completion-checklist.md) §3 says `opencode` "is not
  one of the five MVP providers" and that promoting it "would be a scope change to the map, not an
  ordering choice".
- [ADR 0001](./0001-tool-contracts-and-safety-policy.md) §8 places `OPENCODE_API_KEY` outside the
  credential-isolation guarantee and says that adding CLI support for it "requires extending
  credential-name discovery and passing the resulting names through the composition root".
- The map's **Out of scope** section names "model providers beyond Anthropic, OpenRouter, OpenAI,
  Google, and xAI".

## Decision

1. **`opencode` becomes a sixth `--provider` value**, backed by the OpenCode Go gateway. The
   adapter keeps the existing OpenCode identity, base URL `https://opencode.ai/inference/go`, and
   the OpenAI Responses path `/openai/v1/responses`.
2. **A fixed credential name.** `OPENCODE_API_KEY` joins
   `PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER` in `@coding-agent/ai`, and therefore joins
   `PROVIDER_CREDENTIAL_ENV_VARS`, the scrubbed child environment, and the startup ancestor check.
   This is the static-set route ADR 0001 §8 anticipated. No dynamic `apiKeyEnv` discovery is
   introduced, and the Custom Provider residual in that section stands untouched.
3. **The gateway's own requirements are part of the adapter.** Go asks clients to send a stable
   `x-opencode-session` per conversation, to identify themselves with their own user agent, and to
   send typical coding-agent traffic, and it monitors for abuse. The adapter sends one session id per
   Agent Session and a `coding-agent/<version>` user agent; neither is optional decoration, because a
   trial that is throttled or refused for looking like abuse fails for reasons that are not the
   agent's.
4. **`opencode` joins the shared conformance suite** (ADR 0006 track E). No recorded job runs on it
   until it passes, because an adapter-shaped failure is scored against the agent, and the report
   would then describe the adapter rather than the agent.
5. **The model list stays a catalogue.** `opencode.models.json` gains the Go ids it serves, and the
   provider resolves an id the same way every other provider does. Go's model ids are dateless
   (`deepseek-v4.1-flash`), so the manifest records the id and the job's date, and a later change to
   what that id serves is a new job rather than a silent substitution.
6. **The credential-isolation test covers the new key** on each backend the job uses, as ADR 0005 §7
   and §9 already require for any credential-carrying job.

## Considered options

- **A configurable OpenAI-compatible provider** (the `custom` factory, with a `CUSTOM_BASE_URL` and
  a caller-chosen `apiKeyEnv`). Rejected for now: it needs dynamic credential-name discovery, which
  ADR 0001 §8 states a static set cannot cover, and it records a vendor-neutral provider id in a
  manifest whose purpose is to name what ran.
- **The MiMo Token Plan.** Rejected on arithmetic, not principle: $6 buys 4.1 billion credits, which
  is about 1.2 billion credits per 66-task job on `mimo-v2.6-flash` — roughly 3.4 jobs a month,
  against roughly 38 for $10 here. It also needs its own provider promotion.
- **Staying pay-per-use on OpenRouter.** Rejected on the per-dollar comparison above, given that the
  job will be re-run; it remains the fallback if the promotion is refused, at roughly 1.3 dollars a
  job.

## Consequences

- **The map changes.** Its destination says five model providers, and its **Out of scope** section
  excludes providers beyond those five. Both need the owner group's agreement before this record can
  move from `proposed` to `accepted`; the record does not amend the map by itself.
- **Five records change with it:** ADR 0001 §8's credential scope, ADR 0005 §3's provider list, its
  §6 executable's environment, and its §8 secret-scan prefixes (`oc_sk_`), and ADR 0006 §3's
  exclusion and track E membership.
- **The allowance, not the request rate, is the limit.** Go meters usage in 5-hour, weekly, and
  monthly windows at 20%, 50%, and 100% of a per-model monthly allowance. One 66-task job consumes
  well under the 5-hour window, so wall-clock time is bounded by Modal and Harbor, not by the
  gateway.
- **The free models are not usable here.** The console's free-tier models are served only inside the
  OpenCode client; every other harness receives HTTP 403 "even with a Console API key". Only the
  paid and Go models reach an external harness.
- **A region setting is a prerequisite.** DeepSeek V4.1 Flash is blocked in the default Europe and
  United States regions and needs the workspace's privacy setting set to Global.
