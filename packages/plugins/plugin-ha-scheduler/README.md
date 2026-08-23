# HA Scheduler

`plugin-ha-scheduler` coordinates NocoBase cron jobs across multiple full-featured app nodes.
It is intended for an active-passive or active-active deployment that shares PostgreSQL and Redis.

## Scope

- Wraps callbacks registered through `app.cronJobManager.addJob()`.
- Uses `app.lockManager` when `LOCK_ADAPTER_DEFAULT=redis`.
- Lets custom plugins schedule coordinated intervals through the exported
  `scheduleDistributedInterval()` helper or the server plugin method.
- Does **not** monkey-patch global `setInterval`; doing so would also intercept
  Redis/client/internal timers and can cause deadlocks or alter infrastructure behavior.

## Configuration

```yaml
environment:
  LOCK_ADAPTER_DEFAULT: redis
  LOCK_ADAPTER_REDIS_URL: redis://redis:6379/4
  HA_SCHEDULER_ENABLED: 'true'
  HA_SCHEDULER_CRON_TTL_MS: '300000'
```

The Redis lock adapter must be registered by `plugin-cluster-manager` (or another
adapter provider) before a scheduled task runs. If Redis coordination is not
configured, the plugin preserves normal single-node behavior.

## Important limitation

The plugin can automatically coordinate only jobs that use NocoBase's public
`cronJobManager.addJob()` API. Existing custom `setInterval()` timers are not
intercepted automatically. They must be changed by the owning custom plugin to
use the helper, for example:

```ts
import { scheduleDistributedInterval } from 'plugin-ha-scheduler/dist/server/services';

const timer = scheduleDistributedInterval(app, 'my-maintenance', runMaintenance, 60 * 60 * 1000);
```

Prefer migrating business-affecting timers individually. Cleanup/GC timers can
remain local if duplicate execution is safe and idempotent.

## HA semantics

- A node that acquires the task lock executes the callback.
- Other nodes skip that tick when the lock is held.
- The lock lease is renewed by the configured adapter while the task runs.
- If the owner crashes, Redis expiry allows another node to execute a later tick.
- This is at-least-once scheduling, not exactly-once processing. Tasks should
  remain idempotent and use application-level idempotency keys for side effects.
