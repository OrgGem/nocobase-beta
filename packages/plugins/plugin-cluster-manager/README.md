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
