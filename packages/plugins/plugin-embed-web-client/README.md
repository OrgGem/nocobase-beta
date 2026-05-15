# plugin-embed-web-client

## Overview
Private/offline browser-side document chunking and embedding for Knowledge Base using bundled ONNX models via `@huggingface/transformers`. The plugin ships with `Xenova/all-MiniLM-L6-v2` q8, so a browser can load the model from the NocoBase server without internet access.

## Features
- **Client-Side Processing**: The user's browser chunks documents and computes passage embeddings.
- **Bundled Lite Model**: Includes a small 384-dimensional MiniLM ONNX model under `public/models`.
- **Private Runtime**: Browsers fetch model files only from the NocoBase server, not HuggingFace/CDN.
- **Server Storage/Search**: The server validates and stores pre-computed vectors, then uses the same local ONNX profile for RAG query embeddings.

## Usage
1. Enable the plugin.
2. In Knowledge Base infrastructure, use a vector store backed by PGVector.
3. Create a Knowledge Base with type `WEB_CLIENT_EMBED`.
4. When users upload supported text files, their browser loads the bundled/uploaded ONNX model from this NocoBase server, chunks the text, computes embeddings, and uploads only the chunks plus vectors for storage.
