# Plan: Multi-node HA correctness — load-order safety and shared-service coordination

**Status:** implemented
**Supersedes:** the "HA extensions" refactor (kept as the baseline; this plan adds correctness guarantees).

## Problems

Deployment target: N NocoBase app nodes behind a load balancer (nginx `upstream` / ALB), sharing one database
and one Redis.

### P1 — Load-order race on shared infrastructure (critical)

`PluginManager.sort()` derives ordering **only** from `package.json` `peerDependencies`. Neither
`plugin-ha-scheduler` nor the cluster manager declares an edge between them, so the two can load in any order.

Consequences when `plugin-ha-scheduler` wins the race:

1. `installCronPatch()` wraps `cronJobManager.addJob()` during `beforeLoad`.
2. Other plugins register cron jobs during *their* `load()`.
3. `runWithDistributedLock()` gates on `LOCK_ADAPTER_DEFAULT === 'redis'` and then calls
   `app.lockManager.tryAcquire(...)`.
4. If the cluster manager has not yet executed `ensureRedisLockAdapter()`, `LockManager.getAdapter()` throws
   `Lock adapter "redis" not registered`.
5. `runWithDistributedLock` catches it, logs `lock-error`, and **skips the task**.

So a plain misordering silently disables every scheduled job on every node — no crash, no alert. The
`distributed-lock.ts` doc comment even says the adapter "must be registered by `plugin-cluster-manager` … before a
scheduled task runs", i.e. the dependency is real but unenforced.

### P2 — Cron jobs are not distributed without the scheduler add-on

`CronJobManager` starts every registered job on `afterStart` with no lock, so **every** node runs **every** cron
job. Coordination exists only inside `plugin-ha-scheduler`, which is optional and, per P1, easy to misconfigure.

### P3 — No readiness gate for "HA not wired yet"

A node can accept traffic from the load balancer while its Redis adapters are still missing, so it will serve
requests and run background work with local-only coordination.

## Design

Three layers, ordered by how much they can be trusted.

### L1 — Make the lock adapter independent of the cluster manager (no ordering requirement)

Move the Redis lock adapter **into core**, next to `LocalLockAdapter`, and register it from
`LockManager`'s constructor. `redis` then always resolves; `LOCK_ADAPTER_DEFAULT=redis` works on any node
regardless of which plugins are enabled or in what order they load.

Keep the cluster manager's adapter as a *provider* for older cores via `ensureRedisLockAdapter`, which already
reports `already-registered` and steps aside.

### L2 — Enforce the plugin dependency so ordering can never be wrong

Add `plugin-cluster-manager` to `plugin-ha-scheduler`'s `peerDependencies` so `sort()` places the coordinator
first. This is the cheapest possible guard and is how the rest of the repo expresses load-order requirements.

### L3 — Fail loudly instead of silently skipping

`runWithDistributedLock` must distinguish "another node holds the lock" (skip — correct) from "the lock adapter is
not registered" (misconfiguration — must be visible). Report the latter at `error` level with an explicit
remediation hint, and expose it on the readiness probe so the load balancer stops routing to a node whose
coordination is not wired.

## Tasks

- [x] T1. Move `RedisLockAdapter` into `packages/core/lock-manager` and register `redis` in the `LockManager`
      constructor. Re-export from the package index.
- [x] T2. Have the cluster manager import the core adapter instead of owning a copy; delete the local duplicate.
- [x] T3. Add the `peerDependencies` edge to `plugin-ha-scheduler`.
- [x] T4. Harden `runWithDistributedLock`: distinguish lock contention from a missing adapter, log the latter as an
      error with remediation text.
- [x] T5. Extend the readiness probe to fail when `LOCK_ADAPTER_DEFAULT=redis` but the adapter is unregistered.
- [x] T6. Tests for: adapter always resolvable from core, ordering edge present, contention vs misconfiguration.
- [x] T7. Run `yarn test` + `eslint --fix`; verify `tsc` error count is unchanged.

## Verification requirements

- A node started with only `LOCK_ADAPTER_DEFAULT=redis` (no cluster manager) must take real distributed locks.
- Cron ticks must still be skipped when another node holds the lease.
- Misconfiguration must produce an `error` log and a `not-ready` readiness response, never a silent skip.

## Outcome

### P1 fixed at the root, in two independent ways

The ordering race cannot bite any more, even if a future plugin forgets the dependency:

1. **Core now owns the Redis lock adapter.** packages/core/server/src/redis-lock-adapter.ts registers edis
   on the LockManager inside the Application constructor — the same place that reads
   LOCK_ADAPTER_DEFAULT. The adapter is therefore resolvable before any plugin loads, so load order is
   irrelevant. It also adds cached EVALSHA with NOSCRIPT recovery, so a lock still releases correctly after
   a Redis restart or failover (covered by test).
2. **The dependency edge is now declared.** plugin-ha-scheduler lists plugin-cluster-manager in
   peerDependencies, which is the only signal PluginManager.sort() uses. A test asserts the edge exists so
   it cannot be dropped silently.

The cluster manager keeps ensureRedisLockAdapter, which now reports lready-registered and steps aside.

### P3 fixed — misconfiguration is loud, and gates traffic

- unWithDistributedLock distinguishes *contention* (skip the tick — correct) from *adapter missing* (log at
  error with remediation text and return dapter-unavailable). Previously both were collapsed into a
  warn-level skip, so a misordered cluster silently stopped all cron work on every node.
- isDistributedLockConfigured() inspects the lock registry, not just the env var, and the cluster manager's
  readiness probe gained a lockAdapter check. A node whose coordination is not wired now reports
  
ot-ready, so the load balancer stops sending it traffic.

### P2 unchanged by design

Core CronJobManager still starts every job on every node. Coordination is opt-in through
plugin-ha-scheduler, whose README already documents that only cronJobManager.addJob() callbacks are covered
and that custom setInterval() timers must migrate to scheduleDistributedInterval(). That is a documented
limitation rather than a defect, so it is left as-is.

### Also cleaned up

plugin-ha-scheduler/src/server/services/distributed-lock.ts was a byte-identical duplicate of
src/server/distributed-lock.ts; it is now a re-export so the cron patch and the public helper cannot drift.

## Verification

| Check | Result |
| --- | --- |
| Core adapter tests (edis-lock-adapter, edis-lock-adapter-lease) | 7/7 pass |
| plugin-ha-scheduler suite (incl. load-order guard) | 9/9 pass |
| Cluster manager ha-integration | 11/11 pass |
| eslint --fix on all touched files | exit 0 |
| 	sc --noEmit on the plugin | 11431 lines vs 11432 baseline — no new errors |

Note: during this work I initially left the plugin's copy of the lock-adapter test in place. It mocked edis
without handling the SCRIPT LOAD/EVALSHA handshake, so it hung until the 300s timeout. That file was deleted
and its meaningful assertions (single owner, compare-delete on release, no renewal after takeover) were ported to
the core test with a mock that implements the script protocol.