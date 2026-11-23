# Model pricing for the baseline catalog entries

Research for [Decide catalog pricing schema and baseline rates for supported models](https://datn-fit-hcmus.atlassian.net/browse/CDA-126).
All rates are USD per 1,000,000 tokens and map onto the four **Model Cost** fields
(`input`, `output`, `cacheRead`, `cacheWrite`). Every page was read on **2026-11-23** unless noted.
A `0` means the Model Provider makes no separate charge for that token type; `unverified` means no
primary source confirmed the figure.

## Anthropic

Source: <https://platform.claude.com/docs/en/about-claude/pricing>

| Model id | input | output | cacheRead | cacheWrite (5m) | cacheWrite (1h) |
|---|---|---|---|---|---|
| `claude-opus-5` | 5.00 | 25.00 | 0.50 | 6.25 | 10.00 |
| `claude-sonnet-5` | 2.00 | 10.00 | 0.20 | 2.50 | 4.00 |
| `claude-haiku-4-5` | 1.00 | 5.00 | 0.10 | 1.25 | 2.00 |

- Sonnet 5's $2/$10 was introductory pricing and is now the standard price. The planned
  increase to $3/$15 was cancelled.
- There is no long-context premium for these three models. Claude 4.6 and later include the 1M window
  at standard price. The only prompt-length tier on the page is Claude Haiku 5.5's, above 100k tokens.
- The adapter writes 5-minute ephemeral cache entries, so `cacheWrite` takes the 5-minute rate.

## Google (Gemini API, paid tier, Standard)

Source: <https://ai.google.dev/gemini-api/docs/pricing>, which redirects to <https://aistudio.google.com/docs/pricing>

| Model id | input | output | cacheRead | cacheWrite |
|---|---|---|---|---|
| `gemini-3.6-flash` | 0.75 | 3.75 | 0.075 | 0 |
| `gemini-3.5-flash-lite` | 0.30 | 2.50 | 0.03 | 0 |
| `gemini-3.1-pro-preview` | 2.00 | 12.00 | 0.20 | 0 |

- **Gemini 3.6 Flash doubles on 2027-01-01:** to 1.50 / 7.50 / 0.15, with storage at $1.00 per 1M
  tokens per hour. The rates above hold through 2026-12-31.
- **Gemini 3.1 Pro Preview has a prompt-length tier above 200k tokens:** 4.00 / 18.00 / 0.40. The table
  records the ≤200k tier.
- **Cache writes have no per-token fee.** Explicit context caching is billed as storage per 1M tokens
  per hour (3.6 Flash $0.50, 3.5 Flash-Lite $1.00, 3.1 Pro $4.50). A per-token Model Cost cannot
  express that, so `cacheWrite` is `0`.

## OpenAI (Standard tier, short context ≤272k input tokens)

Source: <https://platform.openai.com/docs/pricing>, which redirects to <https://developers.openai.com/api/docs/pricing>

| Model id | input | output | cacheRead | cacheWrite (30m) | cacheWrite (12h) |
|---|---|---|---|---|---|
| `gpt-5.6-sol` | 4.00 | 20.00 | 0.40 | 5.00 | 10.00 |
| `gpt-5.6-terra` | 2.00 | 12.00 | 0.20 | 2.50 | 5.00 |
| `gpt-5.6-luna` | 0.20 | 1.20 | 0.02 | 0.25 | 0.50 |
| `gpt-5.4-nano` | 0.20 | 1.25 | 0.02 | 0 (none listed) | — |

- **Long context above 272k input tokens** has separate rates. Sol is 8.00 / 30.00 / 0.80, Terra is 4.00 / 18.00 / 0.40, and
  Luna is 0.40 / 1.80 / 0.04.
- **GPT-5.6 Sol has a promotion until 2026-11-30.** The page does not say which price the promotion changes, so the table
  records the listed price.
- **GPT-5.6 lists cache-write columns for two retention windows (30m and 12h).** The page does not
  define them further.

## xAI

Source: <https://docs.x.ai/docs/models>

| Model id | input | output | cacheRead | cacheWrite |
|---|---|---|---|---|
| `grok-4.5` | 2.00 | 6.00 | 0.30 | 0 |
| `grok-4.3` | 1.25 | 2.50 | 0.20 | 0 |

- **Prompts of 200k tokens or more are billed at double for every token in the request.** grok-4.5 becomes
  4.00 / 12.00 / 0.60, and grok-4.3 becomes 2.50 / 5.00 / 0.40.
- **No cache-write fee is listed.** Caching is automatic.

## OpenCode (Go gateway)

Sources: [ADR 0007](../adr/0007-evaluation-provider-and-model.md), quoting <https://opencode.ai/docs/console/go> as read on
2026-11-12; <https://opencode.ai/docs/console/api/inference>; and OpenRouter's `/api/v1/models` for
the peak schedule.

| Model id | input | output | cacheRead | cacheWrite |
|---|---|---|---|---|
| `deepseek-v4.1-flash`, peak | 0.30 | 1.20 | 0.006 | 0 |
| `deepseek-v4.1-flash`, off-peak | 0.15 | 0.60 | 0.003 | 0 |
| `deepseek-v4-pro` | unverified | unverified | unverified | unverified |

- **The Go price table is client-rendered.** On 2026-11-23 neither docs page nor the console page
  served it as static text. The V4.1 Flash figures come from ADR 0007. OpenRouter's listing of the same model,
  `deepseek/deepseek-v4.1-flash-1017`, has identical figures.
- **Peak hours are not published by OpenCode.** OpenRouter's schedule for the same model is peak on weekdays
  01:00–04:00 and 06:00–10:00 UTC, and off-peak at every other time, including weekends.
- **Every OpenCode response reports `usage.cost`.** That field is the USD actually charged, and it is `0` for Go usage
  within its limits. Responses also carry `opencode.list_cost`, the USD at the model's price including peak and
  long-context pricing, and `opencode.allowance`, the share of the Go limits used.

## OpenRouter

Source: `GET https://openrouter.ai/api/v1/models`, which returned 477 models (the catalog holds 273).

- **`pricing` values are decimal strings in USD per single token.** Multiply by 1,000,000 for Model Cost.
  - `prompt` → input, `completion` → output.
  - `input_cache_read` → cacheRead.
  - `input_cache_write` → cacheWrite. A separate `input_cache_write_1h` also exists.
  - Other keys (`image`, `audio`, `web_search`, `internal_reasoning`, …) do not fit Model Cost.
- **`"0"`** marks free models (12 `:free` ids, plus `openrouter/free`).
- **`"-1"`** marks routers whose price depends on the model they route to (8 ids, such as
  `openrouter/auto` and `openrouter/fusion`). Their price is unknown, not free.
- **`overrides`** carries time-of-day schedules by UTC day and hour. It is used by
  `deepseek/deepseek-v4.1-flash-1017`.
- **`deepseek/deepseek-v4-flash-0731`** costs 0.0434 / 0.30 / 0.035.
- **The ADR 0007 fallback `deepseek/deepseek-v4.1-flash-1017` exists on OpenRouter but is missing from
  `openrouter.models.json`.** Its base rates are the peak figures, 0.30 / 1.20 / 0.006.

## Known upcoming price changes

The catalog records the price in force when it was read. These changes are already announced, and
each needs a catalog update when it takes effect:

| Effective | Model id | Change |
|---|---|---|
| 2026-11-30 | `gpt-5.6-sol` | Promotional pricing ends. The page does not say which rates the promotion affects. |
| 2027-01-01 | `gemini-3.6-flash` | Rates double, to 1.50 / 7.50 / 0.15. |

## Rates this record leaves out

Model Cost records only the base tier. Prompt-length tiers (xAI from 200k, OpenAI above 272k,
Gemini 3.1 Pro above 200k), time-of-day schedules and per-hour cache storage are not expressed.
A long prompt on those models therefore costs up to twice what the catalog computes.
