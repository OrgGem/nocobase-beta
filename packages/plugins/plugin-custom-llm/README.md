# plugin-custom-llm

## Overview
OpenAI-compatible LLM provider with auto response format detection for external LLM services.

## Features
- **Custom Endpoints**: Connect to any custom or locally hosted LLM that exposes an OpenAI-compatible API (e.g., vLLM, Ollama, LM Studio).
- **Auto Format Detection**: Automatically handles streaming vs. non-streaming responses.
- **Model Mapping**: Expose specific models (like `llama-3`, `mistral`) to the NocoBase AI system as standard options.

## Usage
1. Enable the plugin in the Plugin Manager.
2. Go to AI settings -> Add Provider -> "Custom LLM".
3. Provide the Base URL and API Key for your custom provider.
4. Add the names of the models you wish to use.
5. You can now select these models when configuring AI Employees or Chat agents.

## Request configuration

The provider extends the host AI plugin's LLM provider and keeps the persisted `custom-llm` provider ID. It merges
NocoBase's default request headers with `requestConfig.extraHeaders`; explicit headers take precedence. The model-list
request uses `modelsConfig.headers` and the configured authentication mode. Its URL and redirect destinations follow
NocoBase's outbound request whitelist.

The following optional keys may be added to **Request config (JSON)** in either client:

```json
{
  "useReasoningEffort": true,
  "useSessionPromptCache": true
}
```

- `useReasoningEffort` opts an OpenAI-compatible endpoint into forwarding the host's non-default reasoning mode using
  LangChain's native reasoning option. The default mode adds nothing. This is separate from **Enable reasoning**, which
  preserves `reasoning_content` across tool calls.
- `useSessionPromptCache` opts an endpoint into receiving the conversation ID as `prompt_cache_key` when a session
  is available. This sends the conversation ID to that provider; use it only when the provider supports the field.

Both options default to disabled for custom endpoints, because some reject unknown request fields. They are automatically
applied for a direct HTTPS `api.openai.com` base URL. Explicit `reasoning` or `reasoning_effort` values in
`modelKwargs` or `extraBody` take precedence over the automatic reasoning setting. An explicit `prompt_cache_key` in either
of those objects takes precedence over the session-derived key.

The installed LangChain OpenAI adapter only serializes its native reasoning option for the model names it recognizes
(currently `o*` and `gpt-5*`, excluding `gpt-5-chat*`). The opt-in alone therefore does not enable reasoning for arbitrary
model aliases. For another endpoint or alias, supply its documented request fields via `modelKwargs` or `extraBody` and
check the endpoint's protocol requirements.

## Attachments and compatibility

Attachments are read through the host File Manager's `getFileStream` contract, including supported external data
sources. DocPixie, when available, receives the attachment buffer. Existing image, text, binary and DocPixie handling
remain provider-specific; the base provider's document conversion is not a drop-in replacement for every custom endpoint.

This update was developed against the `2.2.40` source checkout. The package retains its existing `2.x` compatibility
declaration, but other host versions and individual LLM endpoints require their own verification. Responses API routing
is controlled by the installed LangChain adapter; this plugin does not provide feature parity with NocoBase's dedicated
OpenAI Responses provider.
