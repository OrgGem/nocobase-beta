import type { Application } from '@nocobase/server';
import { LockAcquireError, LockAbortError } from '@nocobase/lock-manager';
import { createHash } from 'crypto';

export interface SchedulerLockOptions {
  key: string;
  ttlMs?: number;
  skipOnLocked?: boolean;
}

export interface RunWithLockResult {
  executed: boolean;
  reason?: 'locked' | 'lock-error' | 'adapter-unavailable';
}

type LockHandle = {
  runExclusive: <T>(task: () => Promise<T>, ttl: number) => Promise<T>;
};

type LockManagerLike = {
  tryAcquire?: (key: string, timeout?: number) => Promise<LockHandle>;
  runExclusive?: (key: string, task: () => Promise<void>, ttl?: number) => Promise<void>;
  registry?: { get?: (name: string) => unknown };
};

const REDIS_LOCK_ENV = 'LOCK_ADAPTER_DEFAULT';
const ADAPTER_NOT_REGISTERED = /not registered/i;

/**
 * Is the distributed lock actually wired?
 *
 * Checking only `LOCK_ADAPTER_DEFAULT=redis` is not enough: the adapter name is
 * read while the LockManager is constructed, so a misordered or missing
 * registration leaves the env var set while every lock call throws. Cron ticks
 * would then be skipped silently on every node.
 */
export function isDistributedLockConfigured(app: Application): boolean {
  if ((process.env[REDIS_LOCK_ENV] || '').toLowerCase() !== 'redis') {
    return false;
  }
  const lockManager = (app as unknown as { lockManager?: LockManagerLike }).lockManager;
  if (!lockManager) {
    return false;
  }
  // When the registry is inspectable, require the adapter to actually be there.
  const registry = lockManager.registry;
  if (registry?.get) {
    return Boolean(registry.get('redis'));
  }
  return true;
}

export async function runWithDistributedLock(
  app: Application,
  options: SchedulerLockOptions,
  task: () => Promise<void> | void,
): Promise<RunWithLockResult> {
  const lockManager = app.lockManager as unknown as LockManagerLike | undefined;
  const distributed = (process.env[REDIS_LOCK_ENV] || '').toLowerCase() === 'redis';
  if (!distributed || !lockManager) {
    await task();
    return { executed: true };
  }

  const ttl = Math.max(options.ttlMs ?? 300_000, 1_000);
  const lockKey = `ha-scheduler:${options.key}`;

  try {
    if (typeof lockManager.tryAcquire === 'function') {
      const lock = await lockManager.tryAcquire(lockKey, 0);
      await lock.runExclusive(async () => {
        await task();
      }, ttl);
      return { executed: true };
    }

    if (typeof lockManager.runExclusive === 'function') {
      await lockManager.runExclusive(
        lockKey,
        async () => {
          await task();
        },
        ttl,
      );
      return { executed: true };
    }

    await task();
    return { executed: true, reason: 'adapter-unavailable' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // A missing adapter is a configuration fault, never contention: every node
    // would fail the same way, so this must be loud rather than skipped.
    if (ADAPTER_NOT_REGISTERED.test(message)) {
      app.logger?.error?.(
        `[ha-scheduler] LOCK_ADAPTER_DEFAULT=redis but the redis lock adapter is not registered; ` +
          `scheduled task "${options.key}" cannot be coordinated across nodes. ` +
          `Core registers the Redis lock adapter during startup when LOCK_ADAPTER_REDIS_URL or REDIS_URL is set, ` +
          `so ensure you are on a core build that provides it and that one of those URLs is configured, ` +
          `or unset LOCK_ADAPTER_DEFAULT to accept per-node execution. Cause: ${message}`,
      );
      if (options.skipOnLocked === false) throw error;
      return { executed: false, reason: 'adapter-unavailable' };
    }

    // Contention (or a lost lease) is expected in a cluster: the other node is
    // running the task, so skipping this tick is correct.
    if (error instanceof LockAcquireError || error instanceof LockAbortError) {
      if (options.skipOnLocked !== false) {
        app.logger?.debug?.(`[ha-scheduler] skipped "${options.key}" (${message})`);
        return { executed: false, reason: 'locked' };
      }
    }

    app.logger?.warn?.(`[ha-scheduler] lock error on "${options.key}": ${message}`);
    if (options.skipOnLocked === false) throw error;
    return { executed: false, reason: 'lock-error' };
  }
}

/**
 * Derive a stable, cross-node lock key for a cron job.
 *
 * The lock key must be identical on every node for the *same* logical job, and
 * different for jobs that merely share a cron expression. It must NOT depend on
 * registration order, because nodes can register jobs in any order (that was the
 * old per-process `jobIndex` bug: node A and node B computed different keys for
 * the same job and both ran it).
 *
 * Identity is resolved in priority order:
 *   1. `haLockKey` — an explicit, caller-provided stable identifier. Always
 *      preferred; this is the only fully reliable option and is REQUIRED to
 *      disambiguate jobs whose closures are structurally identical but capture
 *      different variables (see the limitation below).
 *   2. A hash of `cronTime` + the `onTick` source text. Two different jobs with
 *      distinct callback bodies get distinct keys without any wiring.
 *
 * Limitation: `CronJobParameters` carries no built-in job name, and
 * `onTick.toString()` only reflects the closure *body*, not its captured
 * variables. Two jobs created from the same factory (same source, different
 * captured config) therefore hash to the same key and would be treated as one
 * job — only one runs cluster-wide. Pass an explicit `haLockKey` for such jobs.
 */
export function cronLockKey(input: { expression?: string; tickSource?: string; explicitKey?: string }): string {
  const explicit = input.explicitKey?.trim();
  if (explicit) {
    return `cron:key:${explicit}`;
  }

  const expr = typeof input.expression === 'string' && input.expression.trim() !== '' ? input.expression.trim() : '';
  const tick = typeof input.tickSource === 'string' ? input.tickSource : '';
  const digest = createHash('sha1').update(expr).update('\u0000').update(tick).digest('hex').slice(0, 16);
  return `cron:${expr || 'no-expr'}:${digest}`;
}

export function scheduleDistributedInterval(
  app: Application,
  key: string,
  task: () => Promise<void> | void,
  intervalMs: number,
  ttlMs = Math.max(1_000, Math.min(intervalMs - 1, 300_000)),
): NodeJS.Timeout {
  const timer = setInterval(() => {
    runWithDistributedLock(app, { key: `interval:${key}`, ttlMs }, task).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      app.logger?.warn?.(`[ha-scheduler] interval "${key}" failed: ${message}`);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}
