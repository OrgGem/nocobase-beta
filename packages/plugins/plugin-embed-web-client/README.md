# plugin-embed-web-client

## Overview
Browser-side document chunking and embedding for Knowledge Base using ONNX models via `@huggingface/transformers`. Computes embedding vectors locally - zero API cost.

## Features
- **Client-Side Processing**: Shifts the heavy lifting of calculating vector embeddings to the user's browser.
- **Zero Cost**: Eliminates the need to call paid APIs like OpenAI's `text-embedding-ada-002`.
- **Privacy Focused**: Documents are embedded locally; raw text doesn't need to be sent to a 3rd party embedding service.

## Usage
1. Enable the plugin.
2. In your Knowledge Base settings, select "Web Client (Local)" as the Embedding Provider.
3. When users upload documents, their browser will download the WebAssembly ONNX model (cached locally) and compute the embeddings before uploading the vectors to the NocoBase server.
