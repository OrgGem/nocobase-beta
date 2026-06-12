# plugin-document-understanding

## Overview

Document Understanding configures external document processing services and chains their endpoints into reusable pipelines. Pipelines can process uploaded files or file references, track asynchronous jobs, receive webhook callbacks, and expose enabled pipelines as AI tools when `@nocobase/plugin-ai` is available.

## Features

- **Service configuration**: Configure the base URL, authentication, request timeout, retries, polling defaults, and webhook secret for an external document processing service.
- **Endpoint registry**: Define reusable HTTP endpoints with request/response schemas, file input mode, custom headers, and sync/polling/webhook execution settings.
- **Pipeline orchestration**: Chain endpoints into ordered steps with input mappings, output aliases, conditions, retry/skip/fail behavior, and final output mapping.
- **Job history**: Track pipeline executions, current step, step results, final result, external task IDs, and errors.
- **AI tools**: Register enabled pipelines dynamically as AI tools so other AI features can invoke document processing workflows.

## Usage

1. Enable the plugin.
2. Open the Document Understanding settings page in the NocoBase v2 admin UI.
3. Configure the service connection and authentication.
4. Add endpoints for OCR, classification, extraction, or other external document APIs.
5. Create pipelines that call those endpoints in order and map step outputs into later step inputs.
6. Run a pipeline from the settings playground, an API request, or an AI tool invocation.
7. Inspect job history to review status, results, and errors.

## Notes

- Local file references are limited to files under the configured uploads storage path.
- Webhook callbacks require a matching HMAC-SHA256 signature when a webhook secret is configured.
- Polling and webhook modes depend on the external API returning the configured task ID and status/result fields.
