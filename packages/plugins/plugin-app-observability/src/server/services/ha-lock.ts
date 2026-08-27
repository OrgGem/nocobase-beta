/**
 * HA-lock helper for active-active deployments.
 *
 * Wraps a repeating interval so that only one app node executes the task per
 * interval. Uses app.lockManager which falls back to the in-process
 * LocalLockAdapter when LOCK_ADAPTER_DEFAULT is not set, or uses
 * RedisLockAdapter when LOCK_ADAPTER_DEFAULT=redis (as in the HA compose).
 *
 * Other nodes skip their tick when the lock is held. If the owner crashes,
 * the lock expires and another node picks up the next tick.
 */

type LockManagerLike = {
  tryAcquire?: (
    key: string,
    timeout?: number,
  ) => Promise<{
    runExclusive: <T>(task: () => Promise<T>, ttl: number) => Promise<T>;
  }>;
};

type AppLike = {
  lockManager?: LockManagerLike;
  logger?: {
    debug?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
  };
};

function isLockAcquireError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && typeof (error as { constructor?: unknown }).constructor === 'function') {
    const name = (error as { constructor?: { name?: string } }).constructor?.name;
    if (name === 'LockAcquireError' || name === 'LockAbortError') return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /lock (is locked|acquire timed out|acquire timeout)/i.test(message);
}

/**
 * Schedule a repeating interval where only one node acquires the lock.
 * Returns NodeJS.Timeout so callers can keep the same variable type and
 * clearInterval() on cleanup.
 */
export function runWithDistributedLock(
  app: AppLike,
  key: string,
  task: () => Promise<void>,
  intervalMs: number,
  ttlMs = Math.max(1_000, Math.min(intervalMs - 1, 300_000)),
): NodeJS.Timeout {
  const timer = setInterval(async () => {
    const lockKey = `ha:${key}`;
    const lockManager = app.lockManager;

    try {
      if (!lockManager?.tryAcquire) {
        await task();
        return;
      }
      const lock = await lockManager.tryAcquire(lockKey, 0);
      await lock.runExclusive(async () => {
        await task();
      }, ttlMs);
    } catch (error: unknown) {
      if (isLockAcquireError(error)) {
        // Another node holds the lock — skip this tick
        const message = error instanceof Error ? error.message : String(error);
        app.logger?.debug?.(`[ha-lock] skipped "${key}" (${message})`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      app.logger?.warn?.(`[ha-lock] error on "${key}": ${message}`);
    }
  }, intervalMs);

  timer.unref?.();
  return timer;
}
