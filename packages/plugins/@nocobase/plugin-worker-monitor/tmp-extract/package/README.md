# Worker Monitor

A NocoBase plugin that provides a centralized dashboard for monitoring async tasks, workflow executions, Redis server metrics, and ACL permission caching — all from the admin settings panel.

## Features

### 1. Async Tasks

Monitor all background tasks managed by `@nocobase/plugin-async-task-manager`.

- View task list with status, progress, user, duration
- Filter by status: Pending, Running, Succeeded, Failed, Canceled
- **Cancel** running or pending tasks (with cross-instance pub/sub support)
- **Retry** failed or canceled tasks (re-queues via event queue)
- Pagination and real-time refresh

### 2. Workflow Executions

Monitor all workflow executions and their jobs from `@nocobase/plugin-workflow`.

- View execution list with workflow name, status, trigger time
- Filter by status: Queueing, Started, Resolved, Failed, Error, Aborted, Canceled, Rejected, Retry Needed
- **Expand** any execution to see its individual jobs with node names, status, and results
- **Cancel** running or queued executions (also cancels all pending jobs)
- Pagination and real-time refresh

### 3. Redis Monitor

Real-time Redis server metrics and diagnostics.

- **Server info**: Redis version, uptime
- **Memory**: used/peak memory, fragmentation ratio, max memory policy
- **Performance**: ops/sec, total commands, cache hit rate
- **Clients**: connected/blocked client count, detailed client list (addr, age, idle, db, cmd, flags)
- **Keyspace**: per-database key count, expires, avg TTL
- **Pub/Sub**: active channels and subscriber counts
- **Slow log**: recent slow queries with duration and command
- **Auto-refresh**: configurable interval (5s / 10s / 30s)

### 4. ACL Cache

Redis-based caching layer for ACL permission checks (`acl.can()`) to reduce repeated database queries.

- **Dashboard stats**: total ACL checks, cache hits, cache misses, hit rate
- **Per-role breakdown**: see which roles generate the most ACL checks and their individual hit rates
- **Cached keys viewer**: browse all cached permission entries (role + resource + action)
- **Clear all cache**: flush all ACL cache entries + role caches + system settings cache
- **Clear by role**: selectively clear cache for a specific role
- **Reset stats**: reset the hit/miss counters
- **Auto-refresh**: configurable interval (5s / 10s / 30s)
- **TTL**: cached permissions auto-expire after 5 minutes
- **Automatic invalidation**: role assignment changes and system settings updates trigger cache invalidation (handled by plugin-acl)

**How it works:**
- A middleware intercepts every request before the ACL check
- It looks up the `role:resource:action` combination in Redis
- On cache hit: skips the full ACL computation, uses cached result
- On cache miss: lets the normal ACL check run, then caches the result for future requests
- Stats are tracked in-memory per server instance

## Requirements

- NocoBase 2.x
- Redis must be configured for the Redis Monitor tab to work
- `@nocobase/plugin-async-task-manager` must be active for the Async Tasks tab
- `@nocobase/plugin-workflow` must be active for the Workflow Executions tab

## Installation

```bash
yarn pm enable plugin-worker-monitor
```

## Usage

After enabling the plugin, navigate to **Settings > Worker Monitor** in the admin panel.

The dashboard has four tabs:

| Tab | Description |
|-----|-------------|
| **Async Tasks** | List and manage background async tasks |
| **Workflow Executions** | List and manage workflow execution history |
| **Redis Monitor** | View live Redis server metrics |
| **ACL Cache** | Monitor and manage ACL permission caching |

### Permissions

Access is restricted to admin users with the `pm.plugin-worker-monitor` ACL snippet.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `workerMonitor:list` | GET | List async tasks (supports `page`, `pageSize`, `filter`) |
| `workerMonitor:cancel` | POST | Cancel a running/pending task (`filterByTk`) |
| `workerMonitor:retry` | POST | Retry a failed/canceled task (`filterByTk`) |
| `workerMonitorWorkflow:list` | GET | List workflow executions |
| `workerMonitorWorkflow:getJobs` | GET | Get jobs for an execution (`filterByTk`) |
| `workerMonitorWorkflow:cancel` | POST | Cancel a running/queued execution |
| `workerMonitorRedis:info` | GET | Redis server info and stats |
| `workerMonitorRedis:clients` | GET | List connected Redis clients |
| `workerMonitorRedis:pubsub` | GET | List active pub/sub channels |
| `workerMonitorRedis:slowlog` | GET | Get Redis slow log entries (`count`) |
| `workerMonitorAclCache:stats` | GET | ACL cache hit/miss statistics |
| `workerMonitorAclCache:listKeys` | GET | List all cached ACL permission keys |
| `workerMonitorAclCache:clear` | POST | Clear all ACL cache entries and role caches |
| `workerMonitorAclCache:resetStats` | POST | Reset in-memory ACL stats counters |
| `workerMonitorAclCache:clearRole` | POST | Clear cache for a specific role (`roleName`) |

## Supported Languages

- English (en-US)
- Vietnamese (vi-VN)
- Chinese (zh-CN)
