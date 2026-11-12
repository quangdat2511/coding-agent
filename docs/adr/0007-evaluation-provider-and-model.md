# Evaluation Provider and Model for the Recorded TerminalBench Job

Status: accepted

Date: 2026-11-12

## Context

[Choose the evaluation provider and model for the recorded TerminalBench job](https://datn-fit-hcmus.atlassian.net/browse/CDA-30)
asks which single Model Provider and model the recorded job runs, and on what grounds.
[The TerminalBench evaluation protocol](./0005-terminalbench-evaluation-protocol.md) §7 requires
exactly one provider and model per job, declared in the manifest, and explicitly does not choose
it. [The implementation order](./0006-implementation-order-and-mvp-completion-checklist.md) §7
makes the choice the third item of the "MVP evaluated" checklist and warns that a cheap weak model
produces a valid job that says nothing about the agent.

Five constraints shape the answer:

- The recorded job runs 66 tasks, one attempt each, within 250 Model Turns and 1,000 Tool Calls per
  task (protocol §5), so per-task cost is multiplied by 66 and by whatever the rerun job adds.
- The provider must be one of the five `--provider` values of protocol §3, because the recorded
  command line is a versioned external contract.
- The model must resolve through `ProviderDirectory.getModel`, which reads
  `packages/ai/src/providers/<provider>.models.json`. An unlisted id is refused with exit 2 before
  a session opens.
- `@coding-agent/ai` counts reasoning tokens but never requests a reasoning effort, so the job runs
  at each provider's default. Published TerminalBench figures are produced at each vendor's maximum
  effort inside the vendor's own harness; they rank models, and do not predict what this agent
  scores.
- No paid frontier account exists, and model spend is capped at a small figure.

On [the Terminal-Bench leaderboard](https://www.tbench.ai/leaderboard) (66 tasks, five trials per
row, read 2026-11-12): Claude Opus 5.5 65.8%, Claude Sonnet 5.5 63.9%, GPT-6.1 Sol 60.9%, Grok 4.7
38.8%, GPT-5.6 Sol 38.5%, and Gemini 3.8 Flash 18.2% under mini-SWE-agent.

## Decision

The recorded job runs **`openrouter`** with **`deepseek/deepseek-v4.1-flash-1017`**.

1. OpenRouter is one of the five providers protocol §3 already accepts and track E already covers,
   so this choice amends no command line and no provider scope. Its adapter already exists, and the
   model is selected through the existing `--provider` and `--model` flags and recorded in
   `run.json` and the manifest.
2. The dated id names a snapshot. The unversioned `deepseek/deepseek-v4.1-flash` is rejected because
   it would follow the family forward silently, and a recorded job must name what ran.
3. Budget. On the reference prices read 2026-11-12 ($0.022 and $0.40 per million input and output
   tokens on the cheapest endpoint, cache reads at $0.004) a job of this shape costs between one and
   a few tens of dollars, depending on how many turns the agent actually uses. The cap for the pilot,
   recorded, and rerun jobs together is **$50**, and the three-task smoke job of protocol §7 step 3
   measures the real rate before the 66-task job runs.
4. **Claim.** The job measures this configuration under the `terminalbench` Evaluation Profile. It is
   a reproducible end-to-end result with a per-task diagnostic, not a capability ceiling for the
   agent, and the report does not compare it with the leaderboard. That is the narrowest claim a
   cost-bounded model supports, and it is recorded so the report cannot imply the stronger claim
   that protocol §7 and ADR 0006 §7 were careful not to make.
5. Sampling is unchanged: `SAMPLING_BY_PROVIDER.openrouter` stays
   `{ maxOutputTokens: null, temperature: null }`, so provider defaults apply and `run.json`
   records that fact.
6. No reasoning effort is requested. Adding one changes the `@coding-agent/ai` provider contract
   ([ADR 0004](./0004-package-apis-and-dependency-direction.md) §2) and is a separate decision; the
   recorded job does not wait for it.
7. **Changeability.** The model is a flag, never baked into the artifact or the composition root.
   Each job declares exactly one provider and model in its manifest; a later job on another model is
   a separate job with its own manifest and report (protocol §7), never a pooled result.
8. The provider's HTTP status reaches `MODEL_FAILURE` details through
   [Record the provider HTTP status in MODEL_FAILURE details](https://datn-fit-hcmus.atlassian.net/browse/CDA-83),
   so that ticket targets the `openrouter` adapter.

## Considered options

- **Claude Opus 5.5 or Sonnet 5.5 (65.8% and 63.9%).** The strongest measured models, and the only
  ones that would support a capability claim. Rejected on budget and access: a 66-task job costs
  roughly $150-950 depending on token burn, needs a paid Anthropic account on a tier above the
  entry cap, and this harness cannot reproduce the maximum effort those scores used.
- **GPT-6.1 Sol (60.9%).** The same objection: a capability claim would need a paid account, and the
  cost in this harness is comparable while the ranking gap to the leaders is within noise at one
  attempt per task.
- **OpenCode Zen.** Ruled out by protocol §3 and [ADR 0006](./0006-implementation-order-and-mvp-completion-checklist.md)
  §3: it is not one of the five `--provider` values, its promotion is a scope change to a closed
  map rather than an ordering choice, and the same model costs more per token there.
- **A cheaper-or-equal model with no reference evidence, such as `deepseek-v4-pro`.** Rejected as
  neither cheaper nor more defensible: it buys the same class of claim for more money.
- **Waiting for a frontier budget.** Rejected: the choice blocks CDA-83 and the tier-2 checklist, and
  a stronger model can be added later as its own job without amending this protocol.

## Consequences

- Results describe one cost-bounded configuration. A reader asking how capable the agent is on a
  frontier model will not learn it from this job; a second job on such a model can be added later,
  under the same protocol, with its own manifest and report.
- Until `deepseek/deepseek-v4.1-flash-1017` is added to
  `packages/ai/src/providers/openrouter.models.json`, `--model` refuses it with exit 2. That one-line
  catalogue entry belongs to the ticket that builds the recorded job.
- OpenRouter routes a model id across many upstream hosts with different quantizations (fp8, mxfp4,
  fp4 observed). The manifest records the model id, never the upstream host, so routing variance is a
  stated reproducibility limit, not a hidden one. Pinning a provider order would change the request
  the adapter sends.
- The rerun rule of protocol §7 becomes unambiguous only once CDA-83 carries the HTTP status for
  this adapter; until then a `MODEL_FAILURE` without a status counts as an agent outcome.
