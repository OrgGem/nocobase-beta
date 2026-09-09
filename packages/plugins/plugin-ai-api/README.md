# plugin-ai-api

## Overview

Provides an OpenAI-compatible AI gateway for NocoBase. Requests use NocoBase bearer authentication and are routed through configured LLM services, model permissions, usage groups, quotas, and observability.

## OpenAI-compatible endpoints

The base URL is `<nocobase-origin>/api/ai-llm/v1`.

- `GET /models`
- `POST /chat/completions`
- `POST /completions`
- `POST /embeddings`
- `POST /responses`
- `GET /responses/{response_id}`
- `DELETE /responses/{response_id}`

## Responses API

Create a response:

```bash
curl -X POST "http://localhost:13000/api/ai-llm/v1/responses" \
  -H "Authorization: Bearer $NOCOBASE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o",
    "input": "Explain NocoBase in one sentence"
  }'
```

Streaming follows the OpenAI Responses SSE event schema and ends with `data: [DONE]`:

```json
{
  "model": "openai/gpt-4o",
  "input": "Write a short greeting",
  "stream": true
}
```

Conversation state is opt-in through stored response records. `store` defaults to `true`; pass the returned response ID as `previous_response_id` on the next request. Stored responses are scoped to the authenticated owner and expire after 30 days. Use `store: false` when retrieval and chaining are not needed.

Supported request features include text/image/file input, function tools, function-call output, reasoning-item round trips, structured text format, prompt-cache parameters, and `truncation`. OpenAI-hosted built-in tools, `file_id`, background mode, conversations, reusable prompts, include expansions, and stream retrieval are rejected explicitly because the gateway does not currently implement those services.

The legacy `/completions` and `/chat/completions` endpoints remain independent; `previous_response_id` is only available on `/responses`.

## Configuration

1. Enable the plugin in Plugin Manager.
2. Configure LLM services and enable them for the AI API gateway.
3. Grant roles access in Settings -> Users & Permissions -> AI API.
4. Configure usage groups, model access, rate limits, and quotas as required.
