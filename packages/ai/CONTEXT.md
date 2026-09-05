# AI

The AI context defines the language used for model interaction without tying the rest of the
system to one provider.

## Language

**Model Provider**:
A service that fulfills model requests. The MVP providers are Anthropic, OpenRouter, OpenAI,
Google, and xAI.
_Avoid_: LLM vendor, backend

**Model Interaction**:
A provider-neutral exchange that may produce streamed output or request a controlled Tool Call.
_Avoid_: API call, completion
