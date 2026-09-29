# plugin-cluster-manager

## Overview

Monitor and operate NocoBase cluster nodes, async tasks, workflow executions, event queues, locks, caches,
Redis metrics, container workers, and worker package installation.

The plugin is an **HA extensions layer on top of NocoBase core**. It never re-implements core HA primitives;
it binds them to Redis when the deployment asks for it, and it preserves any adapter another party already
registered.

## Features

- **Cluster Nodes**: Realtime view of active app, worker, task, and sandbox nodes through Redis heartbeats.
- **Task And Workflow Monitoring**: Inspect async tasks and workflow executions, including the node that processed each execution.
- **Runtime Monitors**: Inspect Redis, event queue, distributed locks, ACL cache, and cache manager state.
- **Container Orchestrator**: Manage Docker or Kubernetes worker stacks with leader-only write operations.
- **Worker Packages**: Configure and dispatch apt, npm, and Python package installation across matching node roles.
- **Plugin Operations**: List installed plugins and force-disable or force-remove broken plugin registry records.
- **HA Safety**: Redis-leased Worker IDs, Redis Streams queues with ACK/reclaim/DLQ, ownership-safe distributed locks, shared cache versioning, and public liveness/readiness checks.

## Architecture

Core (v2.2.x) owns the HA building blocks. The plugin either binds them to Redis or extends them:

| Concern | Core object | Cluster Manager role |
| --- | --- | --- |
| Snowflake worker ID | `app.workerIdAllocator` | Installs a Redis lease adapter when none is registered |
| Cross-node messaging | `app.pubSubManager` | Installs a Redis adapter when none is registered |
| Durable queue | `app.eventQueue` | Replaces only the in-memory default adapter |
| Distributed locks | `app.lockManager` | Registers the `redis` adapter when absent |
| Shared cache | `app.cacheManager` | Uses core cache; adds ACL/list-meta caching and version invalidation |

Everything else is a genuine extension that core does not provide:

- **Node registry** (`RedisNodeRegistry`) — Redis heartbeats, TTL-based liveness, per-node metadata.
- **Leader election** (`LeaderElection`) — single-writer orchestrator with fencing and failover.
- **Orchestrator adapters** (`DockerAdapter`, `K8sAdapter`) — worker stack scale/start/stop.
- **Rolling restart** — generation-aware, probe-gated, coordinator-last restarts.
- **Package manager** — apt/npm/python distribution to matching node roles.
- **Cache versioning** — Redis counters bumped by DB hooks to invalidate distributed caches.
- **ACL cache** — request-level permission caching with versioned keys.
- **Doctor** — time-boxed per-node diagnostic sessions with redacted reports.
- **Queue assignment** — map discovered queues to worker stacks.
- **Worker template** — encrypted, per-stack container environment variables.
- **Idempotency** — replay-safe mutations for the cluster management API.
- **Health probes** — public liveness/readiness endpoints for load balancers.

`src/server/ha/core-ha-integration.ts` holds every core-binding decision and
`src/server/ha/core-compat.ts` holds upstream compatibility shims, so both stay easy to audit and remove.

### Adapter resolution

| Adapter | Environment variable | Falls back to |
| --- | --- | --- |
| Worker ID allocator | `WORKER_ID_REDIS_URL` | `REDIS_URL` |
| Pub/Sub | `PUBSUB_ADAPTER_REDIS_URL` | `REDIS_URL` |
| Event queue | `QUEUE_ADAPTER_REDIS_URL` (+ `QUEUE_ADAPTER=redis`) | `REDIS_URL` |
| Locks | `LOCK_ADAPTER_REDIS_URL` | `REDIS_URL` |

Each binding is reported in the startup log as one of `installed`, `already-registered`, `disabled`, or
`unavailable`. When a binding is `already-registered`, the existing adapter is left untouched — this is what
keeps the plugin safe on builds where core wires Redis natively.

## Two-node HA configuration

Both NocoBase app nodes must use the same values for `APP_NAME`, `APP_KEY`, `APP_AES_SECRET_KEY`, database,
Redis endpoints, and plugin build. Each process receives a different Redis-leased Snowflake Worker ID.

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

Use `noeviction` on Redis instances that hold queues, locks, or Worker ID leases. Cache Redis may use an
LRU/LFU eviction policy.

Configure the AWS ALB target group health check to use:

```text
/api/clusterManagerHealth:readiness
```

The lightweight process liveness endpoint is:

```text
/api/clusterManagerHealth:liveness
```

For retryable Cluster Manager mutation requests, clients should send a stable `Idempotency-Key` header.
Reusing the key with the same request replays the stored result; reusing it with a different payload returns
HTTP 409.

## Usage

1. Enable the plugin.
2. Only accessible to Super Admins.
3. Navigate to System Settings -> Cluster Manager.
4. Use the dashboard to troubleshoot performance issues, retry failed background tasks, or clear caches.
