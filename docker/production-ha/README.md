# NocoBase Production HA Stack

> For the current two-server AWS ALB deployment, use
> [`docker-compose.app-ha.yml`](./docker-compose.app-ha.yml) with
> [`.env.app-ha.example`](./.env.app-ha.example). The original
> `docker-compose.yml` below remains the single-host all-in-one development and
> operations stack.

## Two application servers behind AWS ALB

The new compose file is intentionally application-only. PostgreSQL, Redis and
NFS are external shared services. Run one profile on each server:

```bash
# Both servers
cp .env.app-ha.example .env.app-ha
# Edit it and use identical DB, Redis and secret values on both servers.

# Server 1
docker compose --env-file .env.app-ha \
  -f docker-compose.app-ha.yml --profile node1 up -d

# Server 2
docker compose --env-file .env.app-ha \
  -f docker-compose.app-ha.yml --profile node2 up -d
```

Register both targets in one AWS ALB target group:

```text
server-1-private-ip:13000
server-2-private-ip:13000
health check path: /api/clusterManagerHealth:readiness
success code: 200
```

Both nodes use an empty `WORKER_MODE`, so each serves HTTP/WebSocket requests
and consumes background jobs. The corresponding Redis URL for every function
must be identical across the two nodes. Different functions may use separate
Redis servers or logical databases.

The shared NFS export is mounted at `/app/nocobase/storage/plugins`. Publish a
complete plugin build to a staging release directory and switch it atomically;
do not overwrite files in place while either app is running. Restart the two
nodes one at a time, waiting for readiness `200` before draining the other node.

## Architecture

```
Client -> nginx (LB :80)
           -> app-main      (primary HTTP + WebSocket + workers)
           -> app-backup-1  (HTTP failover + workers)
           -> app-backup-2  (HTTP failover + workers)

           ├── redis 8  (cache db0 + pub/sub/queue/locks db1-db4)
           └── postgres 16 (tuned for production)
```

Startup is deliberately serialized because custom plugin `load()` hooks may
also call `db.sync()`:

```text
app-main install/version check/upgrade -> healthy
app-backup-1 start                      -> healthy
app-backup-2 start                      -> healthy
nginx balances new requests across all healthy app nodes
```

`app-main` is the only migration leader. It performs a full upgrade when
`storage/.upgrading` exists, or when the image version differs from the database
version. On an ordinary same-version restart, the upgrade command exits early.
Backups run plain `yarn start` without `--quickstart` and perform an HTTP 200 +
JSON version readiness check against their predecessor before starting.

This stack is pinned to `nocobase/nocobase:2.1.30-full` via
`NOCOBASE_VERSION=2.1.30-full`. The compose fallback also uses the same tag, so
fresh deployments and existing `.env` based deployments resolve to the same
NocoBase version. All three app containers use `WORKER_MODE=''`, so they also
consume registered background queues. Worker containers spawned separately by
`plugin-cluster-manager` inherit the app container image. They are always
started with `APP_ROLE=worker`, `APP_NODE_ROLE=worker`, and `WORKER_MODE=*`
unless the worker stack explicitly narrows the queue mode. Before `yarn start`,
the managed worker branch waits for `CLUSTER_MANAGER_WORKER_READY_URL`; it exits
on timeout instead of racing the app-main migration gate.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your secrets (APP_KEY, ENCRYPTION_FIELD_KEY, DB_PASSWORD)

docker compose up -d
```

## Upgrade to NocoBase 2.1.30

Before upgrading, make a database backup. NocoBase supports upgrades only; if a
rollback is required, restore the backup and start again with the previous image
tag.

```bash
cd docker/production-ha

# Confirm the target version.
grep '^NOCOBASE_VERSION=' .env

# Optional backup example. Adjust the output path for your environment.
docker compose exec postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/nocobase-before-2.1.30.dump'
docker compose cp postgres:/tmp/nocobase-before-2.1.30.dump ./nocobase-before-2.1.30.dump

# Pull and recreate the migration leader and two serialized backups.
docker compose pull app-main app-backup-1 app-backup-2
docker compose up -d app-main app-backup-1 app-backup-2 nginx

# Watch the migration leader and readiness gates.
docker compose logs -f app-main app-backup-1 app-backup-2
docker compose ps
```

If plugin-cluster-manager has created worker containers outside this compose
file, recreate those workers after `app-main` is healthy so they use the same
`2.1.30-full` image. The compose app nodes all use the same image tag.

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

# Preferred: use Cluster Manager -> Hard Restart Cluster. It restarts one app
# node at a time, waits for a new healthy generation, and restarts its own
# coordinator last.

# CLI fallback: recreate one app node at a time and wait for health before
# moving to the next node. Never pass all app services to one restart command.
docker compose up -d --no-deps --force-recreate --wait app-backup-1
docker compose up -d --no-deps --force-recreate --wait app-backup-2
docker compose up -d --no-deps --force-recreate --wait app-main

# Recreate nginx last only when its configuration changed.
docker compose up -d --no-deps --force-recreate --wait nginx
```

Or add `APPEND_PRESET_LOCAL_PLUGINS=plugin-worker-monitor` in `.env` if the plugin is
already in the image's `node_modules`.

## Scaling

Add more app or worker nodes:

```yaml
# docker-compose.override.yml
services:
  app-backup-3:
    <<: *nocobase-base
    environment:
      <<: *nocobase-env
      APP_NODE_ROLE: backup
      APP_START_AFTER_URL: http://app-backup-2:13000/api/app:getInfo
      WORKER_MODE: ''
      APP_PORT: 13000
    depends_on:
      app-backup-2:
        condition: service_healthy
```

Then update `nginx.conf` upstream:
```nginx
upstream apps {
    least_conn;
    server app-main:13000 max_fails=1 fail_timeout=5s;
    server app-backup-1:13000 max_fails=1 fail_timeout=5s;
    server app-backup-2:13000 max_fails=1 fail_timeout=5s;
    server app-backup-3:13000 max_fails=1 fail_timeout=5s;
}
```

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `WORKER_MODE=!` | HTTP only, no background jobs |
| `WORKER_MODE=*` | Background jobs only, no HTTP |
| `CLUSTER_MANAGER_WORKER_READY_URL` | Deployment-specific app-main readiness endpoint for dynamic workers |
| `CLUSTER_MANAGER_WORKER_IMAGE` | Optional explicit worker image; otherwise Docker inherits app-main's image |
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
