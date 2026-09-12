# CDA-15: Compare streaming and tool-calling semantics across MVP providers

## Decision

**Recommendation:** `packages/ai` should define one provider-neutral contract with six normalized
shapes, and treat every deviation below as an explicit, typed escape hatch rather than hiding it:

1. **Normalized stream events**: a discriminated union per turn,
   `stream_start → (content_block_start | content_block_delta | content_block_stop)* →
   turn_delta (usage/stop-reason updates) → turn_end`, plus an `error` event that can occur at any
   position. Anthropic's and OpenAI Responses' named-event flows map onto this directly; OpenAI
   Chat Completions' and Gemini's flatter `data:`-only stream is a degenerate case with only
   `content_block_delta` + a final `turn_end`.
2. **Normalized message/content-block model**: `Message = { role, content: ContentBlock[] }`,
   `ContentBlock = text | tool_call | tool_result | thinking | opaque`. `thinking` carries an
   opaque, provider-owned payload (`signature` / `encrypted_content` / `thoughtSignature`) that
   must be round-tripped verbatim without inspection. All three vendors reject a modified replay.
3. **Normalized tool-call/tool-result shape**: `tool_call = { id, name, arguments: object }`,
   `tool_result = { tool_call_id, content, is_error }`. Arguments always end up parsed at the
   runtime boundary even though every provider transmits them as a string or string-delta on the
   wire. Do not assume a tool-call `id` is always provider-issued: pre-Gemini-3 `generateContent`
   correlates by position/name instead.
4. **Normalized usage shape**: `{ inputTokens, outputTokens, cachedInputTokens, reasoningTokens,
   raw }`, where `raw` is the escape hatch for counters with no universal equivalent (Anthropic
   cache tokens, OpenAI reasoning tokens, Gemini per-modality counts, OpenRouter `cost`). Treat
   "usage only known at stream end" as the default; only Anthropic confirmedly streams cumulative
   usage mid-generation.
5. **A documented cancellation contract, not a uniform one**. Expose three explicit capabilities: (a)
   client-side stream abort (always available, billing not guaranteed to stop); (b) provider-native
   in-flight cancel (confirmed only for OpenAI Responses **background** requests and for a subset
   of OpenRouter's upstream providers); (c) async-job cancel (Anthropic Message Batches only).
6. **A normalized finish-reason enum**: `end_turn | max_output_tokens | tool_call |
   stop_sequence | content_filter | error | other`, always paired with the provider's raw value
   (OpenRouter already ships exactly this pattern: `finish_reason` + `native_finish_reason`).

**Escape hatches the abstraction must keep visible:**

- **Anthropic's ordering rule**: all `tool_result` blocks for a turn must be batched into one
  `user` message, first in its content array, immediately after the `tool_use` turn. Stricter than
  every other provider. A provider-neutral tool loop should default to this shape since it's a
  strict superset of what everyone else accepts.
- **A single provider can expose two live, differently-shaped generation APIs at once**: OpenAI
  (Chat Completions, legacy; Responses, recommended) and, in a finding the ticket didn't anticipate,
  **Google** (`generateContent`, legacy; a new GA **Interactions API**, recommended). The
  abstraction needs an explicit API-variant selector per provider, not one wire format per vendor.
- **xAI's two endpoints diverge structurally**: the OpenAI-Chat-Completions-compatible endpoint is
  now labeled *legacy* and sends tool arguments whole in one chunk even while streaming; the
  current primary endpoint, `/v1/responses`, is OpenAI-Responses-shaped instead.
- **OpenRouter doesn't normalize everything**: unsupported request parameters are silently dropped,
  and stream-cancellation/billing-on-abort is documented as provider-dependent.
- **Server-side tool calls** (Anthropic web search/code execution, OpenAI hosted tools, xAI
  `web_search_call`/`code_interpreter_call`) appear as content blocks but are executed and resolved
  by the vendor. They must not be routed through the "client supplies a `tool_result`" path.

## Research basis

All retrievals performed live via WebFetch/WebSearch on **2026-09-10**. Two of the five
documentation domains named in the ticket have moved during this research window:
`docs.anthropic.com` → `platform.claude.com/docs`, `platform.openai.com/docs` →
`developers.openai.com/api/docs`. Citations below use the resolved URLs.

- **Anthropic**: [Messages API](https://platform.claude.com/docs/en/api/messages), [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [Errors](https://platform.claude.com/docs/en/api/errors), [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), [Handle tool calls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [Stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons), [Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing), [Billing FAQ](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage).
- **OpenAI**: [Streaming (Responses)](https://developers.openai.com/api/docs/guides/streaming-responses), [Migrating to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Chat Completions streaming](https://developers.openai.com/api/docs/api-reference/chat-streaming), [Chat Completions create](https://developers.openai.com/api/docs/api-reference/chat/create), [Cancel a response](https://developers.openai.com/api/docs/api-reference/responses/cancel), [Background mode](https://developers.openai.com/api/docs/guides/background), [Function calling](https://developers.openai.com/api/docs/guides/function-calling), [Reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Error codes](https://developers.openai.com/api/docs/guides/error-codes), [Responses create](https://developers.openai.com/api/docs/api-reference/responses/create). The dedicated Responses streaming-events reference page exceeded WebFetch's size limit; that catalog is corroborated via the shorter streaming guide and search snippets only, not a full read.
- **Google Gemini** (Vertex AI in scope per the ticket but not separately verified): [Generating content](https://ai.google.dev/api/generate-content), [Migrate to Interactions API](https://ai.google.dev/gemini-api/docs/migrate-to-interactions), [Function calling (current)](https://ai.google.dev/gemini-api/docs/function-calling), [Function calling (legacy)](https://ai.google.dev/gemini-api/docs/generate-content/function-calling), [Thinking](https://ai.google.dev/gemini-api/docs/thinking), [Troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting), [API errors](https://ai.google.dev/gemini-api/docs/api-errors), [Billing](https://ai.google.dev/gemini-api/docs/billing).
- **xAI**: [API reference](https://docs.x.ai/docs/api-reference), [Chat Completions (legacy)](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions), [Streaming](https://docs.x.ai/docs/guides/streaming-response), [Advanced tool usage](https://docs.x.ai/docs/guides/tools/advanced-usage), [Function calling](https://docs.x.ai/docs/guides/function-calling). No dedicated xAI errors page or `/v1/responses` streaming/cancel reference was found.
- **OpenRouter**: [API reference](https://openrouter.ai/docs/api-reference/overview), [Streaming](https://openrouter.ai/docs/api-reference/streaming), [Errors](https://openrouter.ai/docs/api-reference/errors), [Tool calling](https://openrouter.ai/docs/guides/features/tool-calling), [Usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting). The cancellation/billing matrix comes from a [help-center article](https://openrouter.zendesk.com/hc/en-us/articles/51691588409883-How-do-I-cancel-a-streaming-request-and-which-providers-stop-billing-when-I-do) read only via a WebSearch snippet (direct fetch returned HTTP 403).

## Streaming

| Provider/API | Event framing | End-of-stream signal |
| --- | --- | --- |
| Anthropic Messages | Named `event:` types (`message_start`, `content_block_*`, `message_delta`, `message_stop`, `ping`, `error`) | Terminal `message_stop`, no `[DONE]` |
| OpenAI Chat Completions | `data:`-only, shape-discriminated | Literal `data: [DONE]` |
| OpenAI Responses | Checks `event.type`; named `event:` line not confirmed | Terminal `response.completed` / `response.failed` |
| Gemini `generateContent` (legacy) | Not confirmed (accepts `?alt=sse`) | Not documented |
| Gemini Interactions API (new) | Named events (`interaction.created`, `step.*`) | Terminal step/interaction event |
| xAI legacy | `data:`-only, OpenAI-shaped | Literal `data: [DONE]` |
| xAI `/v1/responses` | Not confirmed | Not confirmed |
| OpenRouter | `data:`-only + `: OPENROUTER PROCESSING` keep-alives | Literal `data: [DONE]` |

Tool-call argument fragments must be accumulated and parsed only once complete (Anthropic
`input_json_delta`/`partial_json`, OpenAI `function_call_arguments.delta`/`.done`, Chat-Completions
family index-keyed `tool_calls[].function.arguments` deltas). Mid-stream errors after an HTTP 200
are documented for Anthropic (`event: error`) and OpenRouter (`finish_reason: "error"` in a normal
`data:` event); not confirmed for Gemini `generateContent` or xAI legacy.

## Message structure

| Provider/API | Roles | Reasoning block |
| --- | --- | --- |
| Anthropic Messages | `user`, `assistant` | `thinking`, opaque `signature`, replay-or-400 |
| OpenAI Chat Completions | `system`/`developer`, `user`, `assistant`, `tool` | none |
| OpenAI Responses | `developer`/`system`, `user`, `assistant` (tool results are output items) | `reasoning` item, `encrypted_content` in stateless mode |
| Gemini `generateContent` (legacy) | `user`, `model` | `thought` part + `thoughtSignature`, must resend verbatim |
| Gemini Interactions API (new) | Step-based, role implied by step type | `thought` step, `thought_signature` |
| xAI legacy | Same as OpenAI Chat Completions | Not confirmed |
| xAI `/v1/responses` | Modeled on OpenAI Responses | `effort`-level reasoning control, not a documented content block |
| OpenRouter | Mirrors OpenAI Chat Completions | Not confirmed whether provider-native reasoning blocks pass through |

Anthropic's replay rule is a hard API requirement (400 on mismatch), not a best practice. Treating
all three vendors' reasoning content as one opaque block type (Decision, point 2) avoids
special-casing three different replay rules in the agent loop.

## Tool-call and tool-result semantics

| Provider/API | Call signal | Arguments delivery | Result shape | Must immediately follow the call? |
| --- | --- | --- | --- | --- |
| Anthropic Messages | `tool_use` block | Streamed `partial_json` fragments | `tool_result` block in one `user` message | Yes, hard requirement (400 otherwise) |
| OpenAI Chat Completions | `tool_calls[]` array | Chunked deltas by index | `role: "tool"` message per call | Documented pattern, not enforced |
| OpenAI Responses | `function_call` item | Deltas, finalized whole on `.done` | `function_call_output` item | Documented pattern, not enforced |
| Gemini legacy | `functionCall` part | Whole object, not streamed | `functionResponse` part, `role: "user"` | No, order-independent; correlates by position/name pre-Gemini-3, by `id` from Gemini 3 onward |
| Gemini Interactions | `function_call` step | Not independently verified | `function_result` step | Uses `previous_interaction_id`, not message order |
| xAI legacy | Same as OpenAI Chat Completions | **Whole in one chunk**, even when streaming | Same as OpenAI Chat Completions | Same as OpenAI Chat Completions |
| xAI `/v1/responses` | `function_call` item | Not confirmed | `function_call_output` item | Not confirmed |
| OpenRouter | `tool_calls[]`, OpenAI-shaped | JSON string, accumulation implied | `role: "tool"` message | Mirrors OpenAI Chat Completions |

Every provider supports multiple tool calls in one turn, and every one of them exposes a
request-level flag to disable it: Anthropic `disable_parallel_tool_use`; OpenAI Chat Completions,
OpenAI Responses, xAI, and OpenRouter all use `parallel_tool_calls: false`. Anthropic's
result-ordering rule is the strictest in the survey; xAI's whole-chunk argument delivery is the
sharpest streaming deviation.

## Usage reporting

| Provider/API | Core fields | When available in a stream |
| --- | --- | --- |
| Anthropic Messages | `input_tokens`, `output_tokens` | Partial at `message_start`, **cumulative** on each `message_delta`, final at `message_stop` |
| OpenAI Chat Completions | `prompt_tokens`, `completion_tokens`, `total_tokens` | Final chunk only, requires `stream_options.include_usage` |
| OpenAI Responses | `input_tokens`, `output_tokens` | Not confirmed incremental; documented as a final-object field |
| Gemini | `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount` | Not confirmed whether cumulative per chunk or final-only |
| xAI | Input/output/reasoning/cached tokens (per Responses overview) | Not confirmed |
| OpenRouter | `prompt_tokens`, `completion_tokens`, `total_tokens` (native tokenizer) + `cost` | Always included, final SSE message only |

Only Anthropic is confirmed to stream usage progressively, as a cumulative running total, during
generation. Treat "usage known only at stream end" as the default assumption across the rest.

## Cancellation

| Provider/API | Server-side cancel mechanism | Billing on client-side abort |
| --- | --- | --- |
| Anthropic Messages (sync) | None | Billed if disconnect happens mid-success, per Anthropic's own billing FAQ |
| Anthropic Message Batches | Cancel endpoint | Undispatched requests not billed; already-processed ones are |
| OpenAI Chat Completions | None documented | Not confirmed |
| OpenAI Responses (foreground) | None documented | Not confirmed |
| OpenAI Responses (`background: true`) | Cancel endpoint, idempotent | Not stated |
| Gemini | None documented | Only failed (4xx/5xx) requests confirmed unbilled |
| xAI | Delete-stored-response endpoint found; no in-flight cancel confirmed | Not confirmed |
| OpenRouter | None native; depends entirely on the routed upstream provider | Documented as varying by provider: stops billing for some (OpenAI, Anthropic, xAI, etc.), keeps billing for others (Bedrock, Google, Groq, etc.) |

This is the sharpest escape hatch in the survey: cancellation cannot be a single boolean-returning
method (Decision, point 5). The three-tier model exists specifically because in-flight cancel is
either unavailable, restricted to async/background modes, or provider-dependent everywhere.

## Error and finish-reason semantics

Every provider separates a request-time HTTP error from a 200-response `stop`/`finish` reason, and
every provider (confirmed for Anthropic and OpenRouter; not confirmed either way for the rest) can
also surface an error *after* a stream has already started with HTTP 200.

- **Anthropic** `stop_reason`: `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`,
  `refusal`, `model_context_window_exceeded`.
- **OpenAI Chat Completions** `finish_reason`: `stop`, `length`, `tool_calls`, `content_filter`,
  deprecated `function_call`.
- **OpenAI Responses** `status`: `completed`, `incomplete` (with a reason), `failed`.
- **Gemini** `finishReason`: `FINISH_REASON_UNSPECIFIED`, `STOP`, `MAX_TOKENS`, `SAFETY`,
  `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`,
  `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, plus image-generation-only
  values `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT`, `IMAGE_RECITATION`, `IMAGE_OTHER`, `NO_IMAGE`.
  The safety-adjacent values have no single-value equivalent elsewhere and should map to the
  normalized enum's `content_filter` bucket with the raw value preserved; `UNEXPECTED_TOOL_CALL`
  and `TOO_MANY_TOOL_CALLS` are tool-loop-specific failures with no equivalent in the other four
  providers' enums and should map to `error` with the raw value preserved instead.
- **xAI**: not independently enumerated; presumed to inherit OpenAI's set on the legacy endpoint.
- **OpenRouter**: normalizes to `tool_calls | stop | length | content_filter | error` while keeping
  the provider's own value in `native_finish_reason`, the one vendor that already ships the
  "normalized value + raw escape hatch" pattern this project recommends generalizing.

Anthropic's and OpenRouter's docs both describe the same three-way split worth adopting as the
baseline state machine: pre-output HTTP error, mid-stream error event, and terminal finish-reason
(itself possibly still unusual, e.g. `refusal`).

## Open uncertainties

- OpenAI Responses' full streaming-event catalog and exact error-event shape (reference page too
  large to fetch in full).
- Gemini classic `streamGenerateContent` SSE framing, usage timing, and end-of-stream signal.
- Google's new Interactions API is GA and recommended but was not deeply verified beyond the
  migration guide; treat "Gemini" as two APIs, like OpenAI.
- Vertex AI was in scope per the ticket but not separately verified.
- xAI `/v1/responses` streaming events, cancellation, and finish-reason enum; xAI's error-payload
  shape (assumed from documented OpenAI-SDK compatibility, not directly verified).
- Billing-on-cancel for OpenAI Responses background requests, Gemini client-aborted streams, and
  xAI generally are undocumented. Do not assume they follow Anthropic's or OpenRouter's rules.
- OpenRouter's cancellation/billing matrix was sourced via a search snippet, not a direct fetch.
  Re-verify before treating as load-bearing for a billing-sensitive design.
- Whether OpenRouter passes through Anthropic `thinking` or Gemini `thoughtSignature` blocks in its
  normalized schema, versus dropping them, was not confirmed at all (no source found either way).

Every claim above traces to a primary vendor doc (or Anthropic's own support site) fetched live on
2026-09-10, except the two items flagged above as search-snippet-only.
