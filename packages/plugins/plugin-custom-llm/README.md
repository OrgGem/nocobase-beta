# Plugin Custom LLM (OpenAI Compatible)

NocoBase plugin for integrating external LLM providers that support OpenAI-compatible `/chat/completions` API, with built-in response format normalization and response mapping for non-standard APIs.

## Features

- **OpenAI-compatible**: Works with any LLM provider exposing `/chat/completions` endpoint
- **Auto content detection**: Handles both string and array content blocks (`[{type: 'text', text: '...'}]`)
- **Response mapping**: Transform non-standard API responses to OpenAI format via JSON config (supports streaming SSE and JSON)
- **Reasoning content**: Display thinking/reasoning from DeepSeek-compatible providers (multi-path detection)
- **Stream keepalive**: Prevent proxy/gateway timeouts during long model thinking phases, including non-streaming fallback
- **Tool calling support**: Gemini-compatible tool schema fixing (Zod + JSON Schema)
- **Configurable**: JSON config editors for request and response customization
- **Locale support**: English, Vietnamese, Chinese

## Installation

Upload `plugin-custom-llm-x.x.x.tgz` via NocoBase Plugin Manager UI, then enable.

## Configuration

### Provider Settings

| Field | Description |
|---|---|
| **Base URL** | LLM endpoint URL, e.g. `https://your-llm-server.com/v1` |
| **API Key** | Authentication key |
| **Disable Streaming** | Disable streaming for models that return empty stream values |
| **Stream Keep Alive** | Keepalive is enabled by default; disable only if your provider cannot tolerate invisible heartbeat chunks |
| **Keep Alive Interval** | Interval in ms between keepalive signals (default: 5000) |
| **Keep Alive Content** | Visual indicator text during keepalive (default: `...`) |
| **Timeout** | Custom timeout in ms for slow-responding models; values below 30 minutes are raised to 30 minutes |
| **Request config (JSON)** | Optional. Extra request configuration |
| **Response config (JSON)** | Optional. Response parsing and mapping configuration |

### Request Config

```json
{
  "extraHeaders": { "X-Custom-Header": "value" },
  "extraBody": { "custom_field": "value" },
  "modelKwargs": { "stop": ["\n"] }
}
```

- `extraHeaders` — Custom HTTP headers sent with every request
- `extraBody` — Additional fields merged into the request body
- `modelKwargs` — Extra LangChain model parameters (stop sequences, etc.)

### Response Config

```json
{
  "contentPath": "auto",
  "reasoningKey": "reasoning_content",
  "responseMapping": {
    "content": "message.response"
  }
}
```

- `contentPath` — How to extract text from LangChain chunks. `"auto"` (default) detects string, array, and object formats. Or use a dot-path like `"0.text"`
- `reasoningKey` — Key name for reasoning/thinking content in `additional_kwargs` (default: `"reasoning_content"`)
- `responseMapping` — Maps non-standard LLM responses to OpenAI format before LangChain processes them:
  - `content` — Dot-path to the content field in the raw response (e.g. `"message.response"`, `"data.text"`)
  - `role` — Dot-path to role field (optional, defaults to `"assistant"`)
  - `id` — Dot-path to response ID (optional)

### Response Mapping Examples

| Raw LLM Response | `responseMapping.content` |
|---|---|
| `{"message": {"response": "..."}}` | `message.response` |
| `{"data": {"text": "..."}}` | `data.text` |
| `{"result": "..."}` | `result` |
| `{"output": {"content": {"text": "..."}}}` | `output.content.text` |

### Model Settings

Standard OpenAI-compatible parameters: temperature, max tokens, top P, frequency/presence penalty, response format, timeout, max retries.

## Changelog

### v1.2.0

- **Fix**: Keepalive no longer interferes with tool call sequences (prevents tool call corruption)
- **Fix**: Gemini-compatible tool schema fixing — handles Zod schemas via dual-phase approach (pre/post conversion)
- **Fix**: Keepalive content no longer contaminates saved messages in DB
- **Fix**: Response metadata extraction with long ID sanitization (>128 chars truncated)
- **Fix**: Multi-path reasoning content detection (`additional_kwargs` + `kwargs.additional_kwargs`)
- **Fix**: Improved error recovery in keepalive consumer (immediate error propagation)

### v1.1.1

- Stream keepalive proxy for long thinking phases
- Response mapping for non-standard LLM APIs

### v1.0.0

- Initial release with OpenAI-compatible LLM provider support

## License

Apache-2.0
