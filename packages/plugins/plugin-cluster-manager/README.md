# plugin-cluster-manager

## Overview
Monitor and operate NocoBase cluster nodes, async tasks, workflow executions, event queues, locks, caches, Redis metrics, container workers, and worker package installation.

## Features
- **Cluster Nodes**: Realtime view of active app, worker, task, and sandbox nodes through Redis heartbeats.
- **Task And Workflow Monitoring**: Inspect async tasks and workflow executions, including the node that processed each execution.
- **Runtime Monitors**: Inspect Redis, event queue, distributed locks, ACL cache, and cache manager state.
- **Container Orchestrator**: Manage Docker or Kubernetes worker stacks with leader-only write operations.
- **Worker Packages**: Configure and dispatch apt, npm, and Python package installation across matching node roles.
- **Plugin Operations**: List installed plugins and force-disable or force-remove broken plugin registry records.
- **HA Safety**: Redis-leased Worker IDs, Redis Streams queues with ACK/reclaim/DLQ, ownership-safe distributed locks, shared cache versioning, and public liveness/readiness checks.

## Architecture Flow

1. `src/index.ts` exports the server package. The client package is exposed through `src/client/index.tsx`.
2. The client registers the `Cluster Manager` settings page and renders `ClusterManagerLayout`, which groups the admin tools into tabs.
3. The server `beforeLoad()` imports all collection definitions from `src/server/collections`, including config collections and resource-only collection stubs needed by workflow/ACL lookups.
4. The server `load()` wires runtime services and APIs: Redis node registry, PubSub adapter, Redis lock adapter polyfill, PubSub subscribers, resource actions, plugin force operations, ACL snippet, ACL cache middleware, health endpoint, and orchestrator initialization.
5. `afterStart` starts node heartbeats, worker package auto-install, and leader election. `beforeStop` stops the node registry and releases leadership.
6. Shared runtime state uses Redis and PubSub for heartbeats, execution-node mapping, restart/log/package commands, and package status. Durable settings stay in database collections.

## Usage
1. Enable the plugin.
2. Only accessible to Super Admins.
3. Navigate to System Settings -> Cluster Manager.
4. Use the dashboard to troubleshoot performance issues, retry failed background tasks, or clear caches.

## Two-node HA configuration

Both NocoBase app nodes must use the same values for `APP_NAME`, `APP_KEY`, `APP_AES_SECRET_KEY`, database, Redis endpoints, and plugin build. Each process receives a different Redis-leased Snowflake Worker ID.

```ini
WORKER_MODE=
CACHE_DEFAULT_STORE=redis
CACHE_REDIS_URL=redis://cache-redis:6379/0
PUBSUB_ADAPTER_REDIS_URL=redis://coordination-redis:6379/0
LOCK_ADAPTER_DEFAULT=redis
LOCK_ADAPTER_REDIS_URL=redis://coordination-redis:6379/1
QUEUE_ADAPTER=redis
QUEUE_ADAPTER_REDIS_URL=redis://queue-redis:6379/0
WORKER_ID_REDIS_URL=redis://coordination-redis:6379/2
REDIS_URL=redis://coordination-redis:6379/2
```

Use `noeviction` on Redis instances that hold queues, locks, or Worker ID leases. Cache Redis may use an LRU/LFU eviction policy.

Configure the AWS ALB target group health check to use:

```text
/api/clusterManagerHealth:readiness
```

The lightweight process liveness endpoint is:

```text
/api/clusterManagerHealth:liveness
```

For retryable Cluster Manager mutation requests, clients should send a stable `Idempotency-Key` header. Reusing the key with the same request replays the stored result; reusing it with a different payload returns HTTP 409.
