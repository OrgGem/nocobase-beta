# How To Use `plugin-setup-architecture.md`

`plugin-setup-architecture.md` is a quick reference for understanding or implementing plugins in NocoBase.

## Usage

1. Read **Plugin Lifecycle** first to understand where code belongs: `afterAdd`, `beforeLoad`, `load`, `install`, or enable/disable hooks.
2. If you need to create a new plugin, start with **Cookbook Code Samples > Minimal Plugin Structure**.
3. Identify which group your plugin belongs to in **Condensed Inventory By Pattern**.
4. Open the cookbook section that matches that pattern to find sample code:
   - Settings/admin page: section 2
   - Block plugin: section 3
   - Action plugin: section 4
   - Field/collection/data source: section 5, 6, 7
   - Resource/action/ACL/middleware: section 8
   - Connect to other plugins with `pm.get`: section 9
   - Workflow extension: section 10
   - Notification channel: section 11
   - File/storage: section 12
   - AI provider/tool: section 13
   - Mobile/public route: section 14, 15
   - Sync/cache/runtime state: section 16
   - Cluster/runtime ops plugin such as `plugin-cluster-manager` (under `packages/plugins/`): sections 2, 8, 9, and 16, plus lifecycle wiring around `afterStart` and `beforeStop`
5. Before editing complex plugins, check **Plugins To Inspect Carefully Before Editing**.

## Quick Rules

- Client plugins usually register UI: components, routes, plugin settings, schema initializers/settings.
- Server plugins usually register database logic, collections, migrations, resources, actions, ACL, middleware, events, and sync messages.
- DB/model/migration logic should live in `beforeLoad()`.
- Resource/action/ACL/middleware registration usually belongs in `load()`.
- Default data should live in `install()` and must be idempotent.
- When extending workflow, notification, file-manager, or AI, always register the same `type`/ID on both client and server when both sides participate.
- Long-running runtime services, timers, PubSub subscribers, and leader-election loops should be wired in `load()` and started/stopped through `afterStart`/`beforeStop` handlers.
- Cluster-wide runtime state should use an explicit sync path such as PubSub, Redis keys with TTL, or `sendSyncMessage/handleSyncMessage`; write operations that can affect shared infrastructure should be guarded by leadership or another distributed lock.

## `plugin-cluster-manager` Architecture Mapping

Use this as the reference when editing `packages/plugins/plugin-cluster-manager` (note: this plugin lives under `packages/plugins/` directly, not `packages/plugins/@nocobase/`):

- Client entry: `src/client/index.tsx` registers a plugin settings page. `ClusterManagerLayout` owns the tabbed admin UI and each tab calls server resource actions.
- Server entry: `src/index.ts` exports the server package through `src/server/index.ts`, which exports `src/server/plugin.ts`.
- `beforeLoad()` imports `src/server/collections`. The plugin includes both durable config collections and lightweight collection stubs for resource-only endpoints so NocoBase workflow/ACL lookups can resolve the resource names.
- `load()` composes the runtime layer: Redis node registry, workflow execution tracing, Redis PubSub adapter, Redis lock adapter polyfill, PubSub subscribers, resource/action registrations, ACL snippet, ACL cache middleware, health endpoint, and orchestrator initialization.
- Runtime startup/shutdown is event driven. `afterStart` starts heartbeats, worker package auto-install, and leader election; `beforeStop` stops the registry and releases leadership.
- Cluster state is distributed through Redis and PubSub: node heartbeats, execution-node mapping, remote log request/response keys, restart commands, package-install commands, and package status.
- Orchestrator settings are stored in `orchestratorSettings` with env fallbacks. Docker/Kubernetes adapters are connected from those settings, and mutating actions are leader-only.
- When adding a new server resource action, keep the resource name, collection stub/config collection, ACL snippet, and client API URL aligned.

## Important Pitfalls & Tricks

### Schema Initializers & `type: 'item'` Trap
In NocoBase 2.x, when registering custom blocks via `this.app.schemaInitializerManager.addItem('page:addBlock', ...)`, **DO NOT include `type: 'item'`** in the configuration object if you want it to appear as a standard clickable menu item in the "Add block" dropdown. 

> **Caveat**: This behavior is based on empirical observation, not documented in the core source. Some existing plugins (e.g., `plugin-action-bulk-edit`) do include `type: 'item'` in their initializer items. If an item does not render in the menu, try removing `type: 'item'` as a debugging step.

**Incorrect (may not render in menu):**
\`\`\`typescript
this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.myBlock', {
  type: 'item', // <--- Try removing this if item is invisible
  name: 'myBlock',
  title: 'My Block',
  Component: 'MyBlockInitializer',
});
\`\`\`

**Safer:**
\`\`\`typescript
this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.myBlock', {
  name: 'myBlock',
  title: 'My Block',
  Component: 'MyBlockInitializer',
});
\`\`\`
