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
