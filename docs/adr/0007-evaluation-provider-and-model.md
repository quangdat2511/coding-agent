# Evaluation Provider and Model for the Recorded TerminalBench Job

Status: proposed

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
- The model must resolve through `ProviderDirectory.getModel`, which reads
  `packages/ai/src/providers/<provider>.models.json`. An unlisted id is refused with exit 2 before
  a session opens.
- `@coding-agent/ai` counts reasoning tokens but never requests a reasoning effort, so the job runs
  at each provider's default. Published TerminalBench figures are produced at each vendor's maximum
  effort inside the vendor's own harness; they rank models, and do not predict what this agent
  scores.
- No paid frontier account exists, and model spend is capped at a student budget.
- The job will be re-run, so the choice is judged per dollar of subscription, not per token.

On [the Terminal-Bench leaderboard](https://www.tbench.ai/leaderboard) (66 tasks, five trials per
row, read 2026-11-12): Claude Opus 5.5 65.8%, Claude Sonnet 5.5 63.9%, GPT-6.1 Sol 60.9%, Grok 4.7
38.8%, GPT-5.6 Sol 38.5%, and Gemini 3.8 Flash 18.2% under mini-SWE-agent. No leaderboard row
exists for the model this record chooses.

## Decision

The recorded job runs **`opencode`** — the OpenCode Go gateway — with **`deepseek-v4.1-flash`**.

1. **The subscription is the reason.** Go costs $10 a month and includes $100 of DeepSeek V4.1
   Flash usage at the allowance's list prices ($0.15 and $0.60 per million input and output tokens
   off-peak, cache reads at $0.003), so one month covers roughly 38 jobs of this shape. The same
   $10 spent pay-per-use buys roughly 7.7.
2. **One job costs about $2.6 of that allowance** off-peak — roughly 25M cached input, 6M uncached
   input, and 2.6M output tokens — which is well inside the 5-hour window at 20% of the monthly
   allowance. The gateway meters allowance, not requests, so the allowance is the binding
   constraint, not a requests-per-minute limit.
3. **The provider is promoted as part of this decision, and that is the scope change.** `opencode`
   becomes the sixth `--provider` value; `OPENCODE_API_KEY` joins the fixed credential set in
   `@coding-agent/ai` and therefore the scrubbed child environment and the startup ancestor check;
   the adapter speaks the Go gateway (`https://opencode.ai/inference/go` with the OpenAI Responses
   path) and sends the stable `x-opencode-session` and a `coding-agent/<version>` user agent that
   the gateway asks for; and `opencode` joins the shared conformance suite. No recorded job runs on
   it until the conformance suite and the credential-isolation test of protocol §7 pass, because an
   adapter-shaped failure would be scored against the agent. This is why the map's destination and
   its out-of-scope line change: they say five providers, and after this record there are six.
4. **Claim.** The job measures this configuration under the `terminalbench` Evaluation Profile. It is
   a reproducible end-to-end result with a per-task diagnostic, not a capability ceiling for the
   agent, and the report does not compare it with the leaderboard. That is the narrowest claim a
   cost-bounded model supports, and it is recorded so the report cannot imply the stronger claim that
   protocol §7 and ADR 0006 §7 were careful not to make.
5. Sampling is unchanged: `SAMPLING_BY_PROVIDER.opencode` is `{ maxOutputTokens: null, temperature:
   null }`, so provider defaults apply and `run.json` records that fact.
6. No reasoning effort is requested. Adding one changes the `@coding-agent/ai` provider contract
   ([ADR 0004](./0004-package-apis-and-dependency-direction.md) §2) and is a separate decision; the
   recorded job does not wait for it.
7. **Changeability.** The model is a flag, never baked into the artifact or the composition root.
   Each job declares exactly one provider and model in its manifest; a later job on another model is
   a separate job with its own manifest and report (protocol §7), never a pooled result.
8. The provider's HTTP status reaches `MODEL_FAILURE` details through
   [Record the provider HTTP status in MODEL_FAILURE details](https://datn-fit-hcmus.atlassian.net/browse/CDA-83),
   so that ticket targets the `opencode` adapter.

## The five considerations the ticket asked to weigh

1. **What the job demonstrates.** It demonstrates that the agent works end to end on the full
   dataset, and reports how well *this configuration* does. It does not establish how well the agent
   would work with a frontier model, because nothing in this budget buys that comparison.
2. **A second job on another model.** None for the MVP. Protocol §7 permits additional jobs and never
   pools their results, but a second job is a second 66-task run and a second set of task
   environments, so it is an additive experiment, not part of this effort. The subscription's
   allowance is what makes such an experiment affordable later.
3. **Tool-calling reliability over long sessions.** No independent long-horizon result exists for
   this model: it appears on no Terminal-Bench row, and a vendor benchmark would not be evidence of
   250-turn persistence. What the choice does control is truncation pressure — 1M context and 384K
   maximum output are far beyond a 250-turn session — and DeepSeek documents thinking as the model's
   default mode, which the harness neither requests nor disables. The risk that a model stops early
   is visible rather than hidden: the harness ends the session at the first Candidate Completion, so
   an early stop lands in the per-task table as a failure. The three-task smoke job measures it
   before the 66-task job spends the allowance, and if early stopping dominates, the model is changed
   by a later decision, not by editing this one.
4. **The provider's HTTP status in `MODEL_FAILURE` details.** A gateway returns an HTTP status on
   error like any other provider. The adapter drops it today:
   `packages/ai/src/api/openai-responses.ts` catches the SDK error and emits `{ message }` with no
   `code`, so a failure carries a message and no status. CDA-83 carries it for this adapter; until
   then a `MODEL_FAILURE` without a status is not rerun-eligible and counts as an agent outcome.
5. **Rate limits and concurrency.** Go limits allowance per model in three windows — 5 hours at 20%
   of the monthly allowance, weekly at 50%, monthly at 100% — and its published request estimates for
   this model are in the tens of thousands per 5-hour window, far above the roughly 2,600 requests one
   job issues. Concurrency stays Harbor's `-n` and changes wall-clock time only (protocol §7). The
   gateway asks for a stable session id and a real client user agent and monitors for abuse, which
   item 3 of the decision makes part of the adapter.

## Considered options

- **Claude Opus 5.5 or Sonnet 5.5 (65.8% and 63.9%).** The strongest measured models, and the only
  ones that would support a capability claim. Rejected on budget and access: a 66-task job costs
  roughly $150-950 depending on token burn, needs a paid Anthropic account on a tier above the entry
  cap, and this harness cannot reproduce the maximum effort those scores used.
- **GPT-6.1 Sol (60.9%).** The same objection: a capability claim would need a paid account, and the
  ranking gap to the leaders is within noise at one attempt per task.
- **Gemini 3.8 Flash.** Admissible without any amendment, free for a smoke job, and $0.75/$3.75
  paid — about $16 a job. Rejected because it is several times the subscription's marginal cost for
  the same class of claim, and its only public TerminalBench row (18.2%) comes from a weaker harness,
  so it is not a like-for-like comparison either.
- **A configurable OpenAI-compatible provider** (the `custom` factory, with `CUSTOM_BASE_URL` and a
  caller-chosen `apiKeyEnv`). Rejected: it needs dynamic credential-name discovery, which ADR 0001
  §8 states a static set cannot cover, and it records a vendor-neutral provider id in a manifest
  whose purpose is to name what ran.
- **The MiMo Token Plan.** Rejected on arithmetic: $6 buys 4.1 billion credits, about 1.2 billion
  credits per job on `mimo-v2.6-flash`, roughly 3.4 jobs a month against roughly 38 here. It would
  also need its own provider promotion.
- **Pay-per-use on OpenRouter.** Kept as the fallback: admissible today, about $1.3 a job, and it
  needs no amendment. It loses on cost per dollar once the job is re-run.

## Consequences

- **The map changes.** Its destination says five model providers and its **Out of scope** section
  excludes providers beyond those five. Both need the owner group's agreement before this record
  moves from `proposed` to `accepted`; the record does not amend the map by itself.
- **Four accepted records are amended with it:** ADR 0001 §8's credential scope, ADR 0005 §3's
  provider list and §8's secret-scan prefixes (`oc_sk_`), and ADR 0006 §3's exclusion and track E
  membership.
- **The credential-isolation test must cover the new key** on each backend the job uses, as protocol
  §7 and §9 already require for any credential-carrying job. Until it passes, the promotion is not
  operative and the OpenRouter fallback remains.
- **A region setting is a prerequisite.** DeepSeek V4.1 Flash is blocked in the default Europe and
  United States regions and needs the workspace's privacy setting set to Global.
- **The free models are not usable here.** The console's free-tier models are served only inside the
  OpenCode client; every other harness receives HTTP 403 "even with a Console API key". Only the paid
  and Go models reach an external harness.
- **Go's model ids are dateless**, so the manifest records the id and the job date, and a change to
  what that id serves is a new job rather than a silent substitution.
- **The allowance is a subscription**, so an incomplete or invalid job spends allowance rather than
  dollars; the smoke job still runs first, because a rerun inside the same month competes for the
  same window.
- Results describe one cost-bounded configuration. A reader asking how capable the agent is on a
  frontier model will not learn it from this job; a second job on such a model can be added later,
  under the same protocol, with its own manifest and report.
