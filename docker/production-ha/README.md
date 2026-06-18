# NocoBase Production HA Stack

## Architecture

```
Client -> nginx (LB :80)
           -> app-1  (WORKER_MODE=! HTTP + WebSocket)

           -> worker containers managed by plugin-cluster-manager

           ├── redis 8  (cache db0 + pub/sub/queue/locks db1-db4)
           └── postgres 16 (tuned for production)
```

This stack is pinned to `nocobase/nocobase:2.1.6-full` via
`NOCOBASE_VERSION=2.1.6-full`. The compose fallback also uses the same tag, so
fresh deployments and existing `.env` based deployments resolve to the same
NocoBase version. Worker containers spawned by `plugin-cluster-manager` (Docker
adapter) inherit the app container's image automatically, so they stay
version-locked with `app-1` without configuring an image per stack.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your secrets (APP_KEY, ENCRYPTION_FIELD_KEY, DB_PASSWORD)

docker compose up -d
```

## Upgrade to NocoBase 2.1.6

Before upgrading, make a database backup. NocoBase supports upgrades only; if a
rollback is required, restore the backup and start again with the previous image
tag.

```bash
cd docker/production-ha

# Confirm the target version.
grep '^NOCOBASE_VERSION=' .env

# Optional backup example. Adjust the output path for your environment.
docker compose exec postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/nocobase-before-2.1.6.dump'
docker compose cp postgres:/tmp/nocobase-before-2.1.6.dump ./nocobase-before-2.1.6.dump

# Pull and recreate the app container with the pinned 2.1.6 image.
docker compose pull app-1
docker compose up -d app-1 nginx

# Watch the upgrade/startup logs until the app is healthy.
docker compose logs -f app-1
docker compose ps
```

If plugin-cluster-manager has created worker containers outside this compose
file, recreate those workers after `app-1` is healthy so they use the same
`2.1.6-full` image. Workers created by the Docker orchestrator now inherit the
app container's image automatically, so they stay version-locked with `app-1`
after the recreate.

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

# Restart the compose-managed app and proxy
docker compose restart app-1 nginx
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
    server app-1:13000;
    server app-2:13000;
    server app-3:13000;
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
