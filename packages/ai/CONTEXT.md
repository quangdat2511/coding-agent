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
