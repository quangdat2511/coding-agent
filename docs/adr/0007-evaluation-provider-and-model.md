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

Five facts bound the answer. The job runs 66 tasks, one attempt each, within 250 Model Turns and
1,000 Tool Calls per task (protocol §5), so a per-task cost is multiplied by 66. The model must
resolve through `ProviderDirectory.getModel`, which reads
`packages/ai/src/providers/<provider>.models.json`, because an unlisted id is refused with exit 2
before a session opens. `@coding-agent/ai` counts reasoning tokens but never requests a reasoning
effort, so the job runs at each provider's default, while the published TerminalBench figures are
produced at each vendor's maximum effort inside the vendor's own harness. No paid frontier account
exists. And the job will be re-run, so the choice is judged per dollar of subscription rather than
per token.

On [the Terminal-Bench leaderboard](https://www.tbench.ai/leaderboard) (66 tasks, five trials per
row, read 2026-11-12): Claude Opus 5.5 65.8%, Claude Sonnet 5.5 63.9%, GPT-6.1 Sol 60.9%, Grok 4.7
38.8%, GPT-5.6 Sol 38.5%, and Gemini 3.8 Flash 18.2% under mini-SWE-agent. No leaderboard row
exists for the model this record chooses.

Go's terms are quoted from [the Console Go documentation](https://opencode.ai/docs/console/go) and
[the harnesses page](https://opencode.ai/docs/console/harnesses), both read 2026-11-12: $10 a month
with $100 of DeepSeek V4.1 Flash allowance; list prices $0.15 and $0.60 per million input and
output tokens off-peak, doubled at peak, cache reads at $0.003; per-model windows of 5 hours at 20%
of the month, weekly at 50% and monthly at 100%; Extra Usage billed at Console pay-as-you-go rates;
base URL `https://opencode.ai/inference/go`; and free-tier models refused to every client except
OpenCode with HTTP 403. What the documentation does not say is which status Go returns when a window
is exhausted, which is why item 2 turns that into a rule rather than an assumption.

## Decision

The recorded job runs **`opencode`** — OpenCode's Go subscription gateway, not its pay-as-you-go
Zen plan — with **`deepseek-v4.1-flash`**.

1. **One provider and model, declared, and changeable between jobs.** The job declares
   `opencode`/`deepseek-v4.1-flash` in its manifest and in `run.json`. The model is a flag, never
   baked into the artifact or the composition root, so a later job on another model is a separate
   job with its own manifest and report (protocol §7), never a pooled result.

2. **A subscription, because the job is re-run.** Go costs $10 a month and includes $100 of
   DeepSeek V4.1 Flash usage at the allowance's list prices ($0.15 and $0.60 per million input and
   output tokens off-peak, cache reads at $0.003, doubled at peak). A typical job consumes about
   $2.6 of that allowance off-peak and $5.1 at peak — roughly 25M cached input, 6M uncached input
   and 2.6M output tokens — so one month covers roughly 38 such jobs off-peak and 20 at peak,
   against roughly 7.7 for the same $10 spent pay-per-use at $1.3 a job. The gap is mostly the
   tenfold subsidy — $10 buys $100 of allowance — partly offset by Go's list prices, which are about
   twice OpenRouter's cheapest endpoint. The ground is the plan rather than this month: evaluation
   repeats the job — smoke, recorded, rerun, and the re-runs any change to the agent forces — and
   the subscription overtakes pay-per-use above about eight full jobs a month. The team expects to
   cross that during evaluation; below it, pay-per-use is cheaper, and this record states the
   condition rather than claiming the subscription is cheaper unconditionally.

   **The bound matters as much as the typical case, and it does not fit one window.** At the
   250-turn ceiling, and at about 1,000 output tokens a turn, the same job consumes roughly 400M
   cached and 100M uncached input tokens plus 16.5M output: about $26 of allowance off-peak and $52
   at peak. The 5-hour window allows 20% of the month, about $20, and the weekly window 50%, about
   $50, so even the off-peak ceiling needs more than one 5-hour window and the peak ceiling exceeds
   the weekly allowance too. Go blocks a request once a window is exhausted, unless Extra Usage is
   enabled, in which case it proceeds and is billed at pay-as-you-go Console rates; either way the
   subscription's cost model stops applying mid-job. Nothing in the harness paces token burn — the
   turn ceiling comes from the profile and concurrency from Harbor's `-n` — so the smoke job's
   measured rate, not a pacing rule, decides whether the recorded job fits one window or has to
   spread across several. Go publishes request estimates in the tens of thousands per window, far
   above the roughly 2,600 requests a typical job issues, and no per-minute cap appears in its
   documentation, so the allowance binds, not the request rate.

   **Exhaustion is a cost event, not a pass.** Extra Usage is **on**, with a monthly spend limit set
   in the Console, because the evaluation's token burn is estimated rather than known and a run must
   not stall mid-job for a reason that is not the agent's. When the allowance is exhausted, Go
   continues at Console pay-as-you-go rates until that limit; past it, requests fail and the adapter
   turns the refusal into a `MODEL_FAILURE`. Until CDA-83 lands that failure carries no status and
   scores as an agent outcome; afterwards it is rerun-eligible only for 401, 403, 429 or 5xx, per
   protocol §7, so CDA-83 records the status Go actually returns rather than assuming 429. Two
   consequences follow: the recorded job's manifest must record the limit and the observed spend,
   because the subscription no longer bounds the bill by itself; and the rerun job starts only after
   the window that the recorded job exhausted has reset, because "a rerun trial is never rerun". The
   limit's value is set by a later ticket, once the smoke job has measured the real rate: this
   record fixes the mechanism, not the number.

3. **What the job demonstrates, and what it does not.** It demonstrates that the agent works end to
   end on the full dataset and reports how well *this configuration* does. It does not establish how
   well the agent would work with a frontier model, because nothing in this budget buys that
   comparison. The report states the configuration result and does not compare it with the
   leaderboard, so it cannot imply the stronger claim that protocol §7 and ADR 0006 §7 were careful
   not to make.

4. **No second job on another model, for the MVP.** Protocol §7 permits additional jobs and never
   pools their results, but a second job is a second 66-task run and a second set of task
   environments, so it is an additive experiment rather than part of this effort. The subscription's
   allowance is what makes such an experiment affordable later, without amending this record.

5. **Long-session reliability is accepted as unmeasured, and made visible.** No independent
   long-horizon result exists for this model: it appears on no Terminal-Bench row, and a vendor
   benchmark would not be evidence of 250-turn persistence. The choice does control truncation
   pressure — 1M context and an output cap far beyond a single turn — and DeepSeek documents
   thinking as the model's default mode, which the harness neither requests nor disables.
   A model that stops early is not hidden: the harness ends the session at the first Candidate
   Completion, so an early stop appears in the per-task table as a failure rather than as a limit
   reached. The three-task smoke job bounds the cost of a bad run and shows whether the agent stops
   early on three short CPU tasks; it cannot establish 250-turn persistence, and this record does
   not claim it does. Reliability is therefore not a ground for this choice; it is what the job
   measures, and the conformance suite and the smoke job make it visible rather than assumed. If
   early stopping dominates, the model is changed by a later decision, not by editing this one.

6. **The provider is promoted, and that is the scope change.** This decision makes `opencode` the
   sixth `--provider` value; `OPENCODE_API_KEY` joins the fixed credential set in `@coding-agent/ai`
   as part of the implementation, and therefore the scrubbed child environment and the startup
   ancestor check. The adapter must move to the Go gateway — SDK base URL
   `https://opencode.ai/inference/go/openai/v1`, since the OpenAI SDK appends `/chat/completions`
   itself; the `x-opencode-session` header in place of today's `x-session-id`; and a
   `coding-agent/<version>` user agent — none of which it does today. The session header is also
   what lets Go reuse its prompt cache, which the cost model above assumes, so its value must stay
   stable for the whole Agent Session and differ between sessions: a per-turn UUID would defeat the
   cache and price the typical job's input as uncached, about $6.2 instead of $2.6 off-peak.
   `opencode` then joins the shared conformance suite as a sixth member of the tier-1 provider
   checklist (ADR 0006 §3), so tier 1 completes only once that adapter passes. No recorded job runs
   on it until the conformance suite and the credential-isolation test of protocol §7 pass, because
   an adapter-shaped failure would be scored against the agent. The
   [map](https://datn-fit-hcmus.atlassian.net/browse/CDA-13) fixes five providers in its
   destination and excludes others in its Out of scope section.

7. **Failure handling and settings.** A gateway returns an HTTP status on error like any other
   provider, and the adapter drops it today: `packages/ai/src/api/openai-responses.ts` catches the
   SDK error and emits `{ message }` with no `code`.
   [CDA-83](https://datn-fit-hcmus.atlassian.net/browse/CDA-83) carries it for this adapter; until
   then a `MODEL_FAILURE` without a status is not rerun-eligible and counts as an agent outcome.
   The provider needs its sampling entry (`{ maxOutputTokens: null, temperature: null }`) alongside
   the `ProviderId` addition, so
   `run.json` records provider defaults, and no reasoning effort is requested:
   adding one changes the `@coding-agent/ai` provider contract
   ([ADR 0004](./0004-package-apis-and-dependency-direction.md) §2) and is a separate decision.

## Considered options

- **Claude Opus 5.5 or Sonnet 5.5 (65.8% and 63.9%).** The strongest measured models, and the only
  ones that would support a capability claim. Rejected on budget and access: a 66-task job costs
  roughly $150-950 depending on token burn, needs a paid Anthropic account on a tier above the entry
  cap, and this harness cannot reproduce the maximum effort those scores used.
- **GPT-6.1 Sol (60.9%).** The same objection: a capability claim would need a paid account, and the
  ranking gap to the leaders is within noise at one attempt per task.
- **Gemini 3.8 Flash.** Admissible without amending any record, free for a smoke job, and
  $0.75/$3.75 paid — about $16 a job — though it too needs a catalogue entry, since
  `google.models.json` stops at `gemini-3.6-flash`. Rejected because it is several times the
  subscription's marginal cost for the same class of claim, and its only public TerminalBench row
  (18.2%) comes from a weaker harness, so it is not a like-for-like comparison either.
- **A configurable OpenAI-compatible provider** (the `custom` factory, with `CUSTOM_BASE_URL` and a
  caller-chosen `apiKeyEnv`). Rejected: it needs dynamic credential-name discovery, which
  [ADR 0001](./0001-tool-contracts-and-safety-policy.md) §8 states a static set cannot cover, and it
  records a vendor-neutral provider id in a manifest whose purpose is to name what ran.
- **The MiMo Token Plan.** Rejected on arithmetic: $6 buys 4.1 billion credits, about 1.2 billion
  credits per job on `mimo-v2.6-flash`, roughly 3.4 jobs a month against roughly 38 here. It would
  also need its own provider promotion.
- **Pay-per-use on OpenRouter.** Kept as the fallback: about $1.3 a job and no amendment, though it
  needs the `deepseek/deepseek-v4.1-flash-1017` catalogue entry like any other provider. It loses on
  cost per dollar once the job is re-run.

## Consequences

- **The map is owed a change.** The destination of
  [the map](https://datn-fit-hcmus.atlassian.net/browse/CDA-13) says five model providers and its
  **Out of scope** section excludes others. Updating it is a separate action, and until it happens
  this record and the map disagree.
- **Four accepted records are amended with it:** ADR 0001 §8's credential scope; ADR 0004's
  statement that OpenCode credentials sit outside the declared set; ADR 0005 §3's provider list,
  §7's recorded-job rules and §8's secret-scan prefixes (`oc_sk_`); and ADR 0006 §3's exclusion and
  track E membership, §6 item 7, and §7 item 3. The comment at the head of `credentials.ts` and the
  `Model Provider` entry in `packages/ai/CONTEXT.md` describe the old scope too; CDA-112 fixes
  both.
- **Implementation work is owed, and it is more than a catalogue entry.** `deepseek-v4.1-flash`
  must be added to `packages/ai/src/providers/opencode.models.json`, or `--model` refuses it with
  exit 2; the adapter must target the Go gateway with the session header and user agent; and
  `opencode` must join `ProviderId`, `PROVIDER_CREDENTIAL_ENV_VARS_BY_PROVIDER` and
  `SAMPLING_BY_PROVIDER` in the composition root. All of it belongs to the ticket that builds the
  recorded job.
- **The credential-isolation test must cover the new key** on each backend the job uses, as protocol
  §7 and §9 already require for any credential-carrying job. Until it passes, the promotion is not
  effective in the artifact and the OpenRouter fallback remains.
- **A region setting is a prerequisite.** DeepSeek V4.1 Flash is blocked in the default Europe and
  United States regions and needs the workspace's privacy setting set to Global.
- **The free models are not usable here.** The console's free-tier models are served only inside the
  OpenCode client; every other harness receives HTTP 403 "even with a Console API key". Only the
  paid and Go models reach an external harness.
- **Go's model ids are dateless**, so the manifest records the id and the job date, and a change to
  what that id serves is a new job rather than a silent substitution.
- **The allowance is a subscription**, so an incomplete or invalid job spends allowance rather than
  dollars; the smoke job still runs first, because a rerun inside the same month competes for the
  same window.
- The recorded job reports the profile it ran under and the date; a reader comparing two jobs
  compares two manifests, not two narratives.
