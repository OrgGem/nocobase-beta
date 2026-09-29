# Plan & Implementation: `plugin-cluster-manager` -> HA extensions on core-native infrastructure

**Status:** implemented
**Scope:** `packages/plugins/plugin-cluster-manager/**` only. No changes to `packages/core/**` or `packages/plugins/@nocobase/**`.

## Goal

Turn `plugin-cluster-manager` from a polyfill of core HA (which duplicated `WorkerIdAllocator`,
`PubSubManager`, `EventQueue`, `LockManager`) into an extensions layer that binds those core objects to Redis
without ever overwriting an adapter someone else registered.

Non-goals: changing resource names, ACL snippets, collection names, or the client UI.

## Findings that drove the design

1. Core v2.2.10 constructs `workerIdAllocator`, `pubSubManager`, `eventQueue`, `lockManager`, `cacheManager`,
   `redisConnectionManager` in the `Application` constructor, before any plugin runs `afterAdd()`.
2. `Application.load()` calls `workerIdAllocator.getWorkerId()` after all plugins ran `afterAdd()` and
   `beforeLoad()`. So `afterAdd()` is still the correct place to install the allocator adapter — the previous
   comment claiming the allocation happens "immediately after beforeLoad" was inaccurate, but the placement
   happened to be right.
3. The plugin's old checks were `if (adapter) skip` (pub/sub, worker ID) vs `if (name !== 'MemoryEventQueueAdapter')`
   (queue). Those are the correct semantics, but they were duplicated across private methods with inconsistent
   logging and no way to observe the outcome.
4. `attachments.createdById` was a workaround for a `plugin-file-manager` defect: the collection declares
   `createdBy: true` and the plugin calls `acl.addFixedParams('attachments', ...)` with `createdById`, but core's
   `checkFilterParams` throws `NoPermissionError` when the field is not registered in field metadata. This is not
   a cluster-manager feature and must not be silently dropped.

## Implementation

### Added: `src/server/ha/core-ha-integration.ts`

Pure, dependency-free helpers that make each binding decision explicit and observable:

- `ensureRedisWorkerIdAllocator` — installs on `app.workerIdAllocator` unless `adapter` is set; warns when no URL.
- `ensureRedisPubSubAdapter` — installs on `app.pubSubManager` unless `adapter` is set.
- `ensureRedisEventQueueAdapter` — async; replaces only `MemoryEventQueueAdapter`, preserves connect state across
  the swap, and honours the `QUEUE_ADAPTER`/`QUEUE_ADAPTER_REDIS_URL` opt-in.
- `ensureRedisLockAdapter` — registers `redis` on `app.lockManager` only when the registry has none.
- `resolveHaRedisUrls` / `isRedisEventQueueEnabled` / `summarizeHaIntegration` — shared env resolution and logging.

Each returns `{ component, outcome, message }` where `outcome` is one of `installed`, `already-registered`,
`disabled`, `unavailable`. `never` overwrites an existing adapter.

### Added: `src/server/ha/core-compat.ts`

Holds the upstream compatibility shim that used to sit inline in `load()`:

- `ensureAttachmentsCreatedByField(db)` registers the `createdById` metadata field on `attachments` so core ACL
  `checkFilterParams` stops rejecting non-root attachment writes. Idempotent and safe on a core where the field is
  already declared; no migration needed because `createdBy: true` already creates the physical column.

### Changed: `src/server/plugin.ts`

- `afterAdd()` now delegates to `ensureRedisWorkerIdAllocator`.
- `load()` delegates the `attachments` shim to `ensureAttachmentsCreatedByField`.
- Private `registerPubSubAdapter()` and `registerEventQueueAdapter()` removed; replaced by
  `ensureCoreHaAdapters()`, which runs all three adapter bindings and logs a one-line summary.
- New public `haIntegration: HaIntegrationResult[]` exposes the binding outcomes for diagnostics.
- `package.json` version -> `1.4.0`, description updated.

### Added: `src/server/__tests__/ha-integration.test.ts`

11 tests covering: install when absent, preserve when present (worker ID, pub/sub, queue, lock), in-memory queue
replacement, disabled outcome without a URL, `REDIS_URL` fallback for all four components, and queue opt-in
detection.

## Verification

| Check | Result |
| --- | --- |
| `ha-integration.test.ts` | 11/11 pass |
| Full plugin server suite | 31/32 pass |
| `eslint --fix` on touched files | clean, exit 0 |
| `tsc --noEmit` error count, before vs after | identical (11432) — zero new type errors |

The one failing test is `doctor.test.ts`, which builds a `MockServer` backed by sqlite. `sqlite3` is not
installed in this environment (`require('sqlite3')` fails, and the package is absent from `node_modules`), so
that test fails independently of these changes.

## Follow-ups (out of scope here)

- Upstream the `attachments.createdById` field declaration into `plugin-file-manager` so `core-compat.ts` can be
  deleted.
- If core begins registering a `redis` lock adapter by default, `ensureRedisLockAdapter` will report
  `already-registered` and the plugin needs no change.
