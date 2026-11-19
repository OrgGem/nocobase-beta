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

### LiteLLM Chat Completions

For a LiteLLM service exposing `/v1/chat/completions`, enter its `/v1` base URL and choose **Chat Completions** in
**API mode**. The default **Automatic** lets LangChain select its API as before. The selected mode applies to the
service and all its model aliases, including GPT aliases whose names make LangChain prefer Responses.

In **Claude model aliases**, enter the exact LiteLLM aliases that route to Claude, for example `claude-work` and
`claude-analysis`. The plugin adjusts sampling parameters for those aliases, giving `temperature` precedence over
`top_p`. Leave GPT and Gemini aliases out of this list. The list is stored in the service options, so it also applies
to AI Employee chats where individual model options are not passed to the provider.

For an OpenAI-compatible LiteLLM response, leave `responseMapping` unset. Mapping is only needed when the gateway
returns a different response shape. The provider checks both mapped and unmapped Chat Completions streams for
upstream errors and premature closure, and reports `length` and `content_filter` as incomplete responses. A gateway
must send `[DONE]` or a successful `finish_reason` before closing the stream.

The chat error includes a reference ID. Search the NocoBase backend log for that ID to find the safe error code,
request stage, session, model alias, HTTP status, finish reason and LiteLLM request ID when available. Prompts,
tool payloads, credentials and model signatures are omitted from these diagnostics. For example, an error with
reference `c16e8050-6ec7-4b43-9bc0-6a8b43d5cc48` can be located by searching for that identifier in the backend log.

Chat Completions does not automatically retry a received partial stream or incomplete response. Optional bounded
retries for non-streaming HTTP 429 and 5xx responses can be configured in **Request config (JSON)**:

```json
{ "retry": { "maxRetries": 2, "delayMs": 1000 } }
```

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
