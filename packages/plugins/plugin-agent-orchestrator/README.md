# plugin-agent-orchestrator

## Overview
Hierarchical Multi-Agent orchestration for NocoBase AI Employees. Enables Leader agents to delegate tasks to Sub-Agent employees without modifying core plugin-ai.

## Features
- **Hierarchical Delegation**: Allows AI Leader agents to break down complex tasks and assign them to specialized sub-agents.
- **Seamless Integration**: Plugs directly into the existing AI Employee framework.
- **Execution Tracking**: Monitor sub-agent task execution and responses within the main chat interface.
- **External RAG Search**: Exposes `external_rag_search` so leaders and sub-agents can retrieve context from NocoBase knowledge bases, including external RAG services.

## Usage
1. Enable the plugin in the NocoBase Plugin Manager.
2. Navigate to the AI Employee configuration page.
3. Configure a primary "Leader" agent.
4. Add available "Sub-Agents" as tools or skills to the Leader agent.
5. Interact with the Leader agent; it will automatically delegate tasks when necessary.

## External RAG / Embedding service

Recommended approach: keep source ownership in NocoBase and move chunking, embedding, vector storage, and retrieval to an external lightweight RAG service. This plugin should not own vector infrastructure directly. It delegates search to `plugin-knowledge-base`, which already supports knowledge bases of type `EXTERNAL_RAG`.

### Architecture

1. NocoBase stores the source metadata:
   - uploaded file attachment id, filename, storage id, URL, owner/role access, or
   - datasource/collection/record id for database-backed knowledge.
2. The external RAG service owns:
   - document fetching or receiving source payloads,
   - parsing/chunking,
   - embedding,
   - vector index,
   - retrieval.
3. NocoBase creates a knowledge base with `type = EXTERNAL_RAG` and `options` such as:
   - `ragProvider: "external-http"`
   - `ragApiUrl: "https://rag.example.com/search"`
   - `ragApiKey`
   - `ragNamespace`
   - `ragTopK`
   - `ragScoreThreshold`
4. Agents use the `external_rag_search` tool. The tool calls `plugin-knowledge-base.searchKnowledgeBases()`, so access control and mixed local/external search remain centralized.

### External search contract

The built-in `external-http` strategy expects:

```http
POST /search
Authorization: Bearer <ragApiKey>
Content-Type: application/json
```

```json
{
  "query": "search text",
  "topK": 5,
  "scoreThreshold": 0.3,
  "namespace": "optional-kb-namespace",
  "filter": {}
}
```

Response:

```json
{
  "results": [
    {
      "id": "chunk-or-source-id",
      "content": "matched text",
      "score": 0.82,
      "metadata": {
        "fileId": "123",
        "filename": "contract.pdf",
        "collection": "orders",
        "recordId": "456",
        "sourceUrl": "/api/attachments/123:download"
      }
    }
  ]
}
```

The important rule is that every result should return enough metadata for NocoBase to resolve the original source: `fileId`/`filename` for files, or `collection`/`recordId` for datasource records.

### Lightweight open-source service target

For a small but useful deployment, use a standalone service with:

- Qdrant or LanceDB for vector search.
- FastAPI or Express for `/ingest`, `/delete`, and `/search`.
- A small embedding model such as `BAAI/bge-small-en-v1.5`, `intfloat/multilingual-e5-small`, or another model matching the deployment language.
- A namespace per NocoBase knowledge base.

Minimum API surface:

- `POST /ingest`: receive `{ namespace, source, content | fileUrl | storageRef, metadata }`.
- `POST /delete`: receive `{ namespace, sourceId }`.
- `POST /search`: implement the contract above.

For NocoBase datasource knowledge, send each record as a source document with metadata `{ collection, recordId, fields, updatedAt }`; the RAG service chunks and embeds the selected text fields, then returns `collection` and `recordId` in search results.

### E5/OpenAI-compatible embedding

If the external RAG service uses an E5 family model behind an OpenAI-compatible `/v1/embeddings` API, configure the NocoBase knowledge base with `ragProvider: "e5-http"`. `plugin-knowledge-base` will read the selected embedding LLM service and forward its `baseURL`, `apiKey`, and model to the RAG service.

- embed user queries as `query: <question>`;
- embed document chunks as `passage: <chunk>`;
- use the same model for ingest and search;
- recreate the vector collection when changing models or vector dimensions.

The RAG service still owns chunking, embedding calls, vector storage, and metadata mapping. NocoBase owns the LLM service configuration and search authorization path.
