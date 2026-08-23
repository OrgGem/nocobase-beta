import type { Application } from '@nocobase/server';
import { LockAcquireError, LockAbortError } from '@nocobase/lock-manager';

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
};

export async function runWithDistributedLock(
  app: Application,
  options: SchedulerLockOptions,
  task: () => Promise<void> | void,
): Promise<RunWithLockResult> {
  const lockManager = app.lockManager as unknown as LockManagerLike | undefined;
  const distributed = (process.env.LOCK_ADAPTER_DEFAULT || '').toLowerCase() === 'redis';
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
    if (error instanceof LockAcquireError || error instanceof LockAbortError) {
      if (options.skipOnLocked !== false) {
        app.logger?.debug?.(`[ha-scheduler] skipped "${options.key}" (${error.message})`);
        return { executed: false, reason: 'locked' };
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    app.logger?.warn?.(`[ha-scheduler] lock error on "${options.key}": ${message}`);
    if (options.skipOnLocked === false) throw error;
    return { executed: false, reason: 'lock-error' };
  }
}

export function cronLockKey(expression: string | undefined, index: number): string {
  const expr = typeof expression === 'string' && expression.trim() !== '' ? expression : `job-${index}`;
  return `cron:${expr}:${index}`;
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
