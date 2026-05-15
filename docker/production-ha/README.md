# NocoBase Production HA Stack

## Architecture

```
Client -> nginx (LB :80)
           ├── app-1  (WORKER_MODE=! primary, runs migrations first)
           └── app-2  (WORKER_MODE=! secondary, waits for app-1)

           ├── worker-1 (WORKER_MODE=* all background jobs)
           └── worker-2 (WORKER_MODE=* all background jobs)

           ├── redis 7  (cache db0 + pub/sub+queue db1)
           └── postgres 16 (tuned for production)
```

## Quick Start

```bash
cp .env.example .env
# Edit .env with your secrets (APP_KEY, ENCRYPTION_FIELD_KEY, DB_PASSWORD)

docker compose up -d
```

## Install plugin-worker-monitor

After the stack is running:

```bash
# Build the plugin (from nocobase root)
yarn nocobase build plugin-worker-monitor --no-dts

# Pack it
cd packages/plugins/@nocobase/plugin-worker-monitor
npm pack

# Copy into running container and install
docker cp plugin-worker-monitor-1.0.0.tgz <container>:/tmp/
docker exec -it <container> bash -c \
  "cd /app/nocobase && yarn pm add /tmp/plugin-worker-monitor-1.0.0.tgz && yarn pm enable plugin-worker-monitor"

# Restart all app/worker containers
docker compose restart app-1 app-2 worker-1 worker-2
```

Or add `APPEND_PRESET_LOCAL_PLUGINS=plugin-worker-monitor` in `.env` if the plugin is
already in the image's `node_modules`.

## Scaling

Add more app or worker nodes:

```yaml
# docker-compose.override.yml
services:
  app-3:
    <<: *nocobase-base
    environment:
      <<: *nocobase-env
      WORKER_MODE: "!"
      APP_PORT: 13000
    depends_on:
      app-1:
        condition: service_healthy
```

Then update `nginx.conf` upstream:
```nginx
upstream apps {
    server app-1:80;
    server app-2:80;
    server app-3:80;
}
```

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `WORKER_MODE=!` | HTTP only, no background jobs |
| `WORKER_MODE=*` | Background jobs only, no HTTP |
| `CACHE_DEFAULT_STORE=redis` | Use Redis for caching |
| `REDIS_URL` | Redis for pub/sub + queue coordination |
| `CACHE_REDIS_URL` | Redis for cache storage |

## What Workers Process

| Service Key | Description |
|---|---|
| `workflow:process` | Async workflow executions |
| `async-task:process` | Import/export and other async tasks |

## Redis Monitoring

The `plugin-worker-monitor` provides a settings page at:
**Settings → Worker Monitor → Redis Monitor**

Shows: memory, ops/sec, hit rate, connected clients, pub/sub channels, slow log.

## Knowledge Base with Qdrant

This stack includes Qdrant as the default vector database for
`plugin-knowledge-base`:

| Service | Internal URL | Host debug URL |
|---|---|---|
| `qdrant` | `http://qdrant:6333` | `http://127.0.0.1:6333` |

On startup, `plugin-knowledge-base` can seed:

- vector database: `Default Qdrant`
- vector store: `Default Qdrant Vector Store`
- Qdrant collection: `nocobase_knowledge_base`

Set an embedding service/model in `.env` to seed the vector store automatically:

```env
KB_DEFAULT_EMBEDDING_LLM_SERVICE=<your-llm-service-name>
KB_DEFAULT_EMBEDDING_MODEL=<your-embedding-model>
```

The selected LLM service should expose an OpenAI-compatible embedding API via
`options.baseURL`/`options.baseUrl` and `options.apiKey` if required. Different
embedding models are supported; choose a model whose output dimension matches
the Qdrant collection you use.

Create a normal NocoBase knowledge base with:

| Field | Value |
|---|---|
| Type | `LOCAL` or `WEB_CLIENT_EMBED` |
| Vector Store | `Default Qdrant Vector Store` |

## External RAG HTTP

Use `EXTERNAL_RAG` only when retrieval is delegated to a separate HTTP service.
For services that need NocoBase to forward an embedding model config, use the
generic provider `openai-compatible`:

| Field | Value |
|---|---|
| Type | `EXTERNAL_RAG` |
| Provider | `openai-compatible` |
| API URL | external search endpoint |
| API key | optional bearer token |
| Namespace | e.g. `nocobase` or a per-KB namespace |
| Embedding LLM Service | your configured OpenAI-compatible embedding service |
| Embedding Model | any supported embedding model |

The service should expose:

- `POST /ingest`: `{ namespace, source, content | fileUrl, metadata }`
- `POST /delete`: `{ namespace, sourceId }`
- `POST /search`: `{ query, topK, scoreThreshold, namespace, filter, embedding? }`

Example ingest:

```bash
curl -X POST http://127.0.0.1:8008/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "namespace": "nocobase",
    "source": { "id": "file-123", "filename": "contract.txt" },
    "content": "Contract text to index",
    "metadata": { "fileId": "123", "filename": "contract.txt" }
  }'
```

Search results return `content`, `score`, and metadata such as `sourceId`,
`filename`, `collection`, and `recordId`, matching the `EXTERNAL_RAG` contract
used by `plugin-knowledge-base`.
