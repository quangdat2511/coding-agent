# AI

The AI context defines the language used for model interaction without tying the rest of the
system to one provider.

## Language

**Model Provider**:
A service that fulfills model requests. The MVP providers are Anthropic, OpenRouter, OpenAI,
Google, xAI, and OpenCode (OpenCode Zen).
_Avoid_: LLM vendor, backend

**Model Interaction**:
A provider-neutral exchange that may produce streamed output or request a controlled Tool Call.
_Avoid_: API call, completion

**Provider Directory**:
A registry that catalogs available Model Providers and allows lookup of models and providers by identifier.
_Avoid_: Model registry, models impl

**Provider Credentials**:
Authentication information and secret resolution needed to communicate with a Model Provider.
_Avoid_: Provider auth, API key credential

**Content Block**:
A typed unit of structured content within a message: text, tool_call, or tool_result.
_Avoid_: Content item, message part, chunk

**Finish Reason**:
A normalized completion reason paired with the Model Provider's raw value.
_Avoid_: Stop reason, stop cause

**Tool Declaration**:
The name, description, and parameter schema of a tool, owned by AI and independent of execution.
_Avoid_: Tool definition, tool spec, function definition

**Model Capabilities**:
Declared behavioral differences between Model Providers and API variants that callers can inspect.
_Avoid_: Provider features, model flags, feature set

**Transport Retry Bound**:
The caller-specified maximum number of attempts the AI transport layer may make to re-issue a request that fails before the response stream opens. It never retries after the first stream event.
_Avoid_: Session retry, agent retry, loop retry

