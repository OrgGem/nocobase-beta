import { describe, expect, it, vi } from 'vitest';
import { isDistributedLockConfigured, runWithDistributedLock } from '../distributed-lock';

function createApp(options: {
  lockDefault?: string;
  lockManager?: unknown;
  tryAcquire?: (
    key: string,
    timeout?: number,
  ) => Promise<{ runExclusive: <T>(task: () => Promise<T>, ttl: number) => Promise<T> }>;
}) {
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    lockManager: options.lockManager ?? (options.tryAcquire ? { tryAcquire: options.tryAcquire } : undefined),
    logger,
  } as never;
}

describe('runWithDistributedLock', () => {
  it('runs directly when Redis locking is not configured', async () => {
    const original = process.env.LOCK_ADAPTER_DEFAULT;
    delete process.env.LOCK_ADAPTER_DEFAULT;
    const app = createApp({});
    const task = vi.fn();

    await runWithDistributedLock(app, { key: 'task' }, task);

    expect(task).toHaveBeenCalledOnce();
    process.env.LOCK_ADAPTER_DEFAULT = original;
  });

  it('runs the task through the configured distributed lock', async () => {
    const original = process.env.LOCK_ADAPTER_DEFAULT;
    process.env.LOCK_ADAPTER_DEFAULT = 'redis';
    const runExclusive = vi.fn(async <T>(task: () => Promise<T>) => task());
    const app = createApp({
      tryAcquire: async () => ({ runExclusive }),
    });
    const task = vi.fn();

    const result = await runWithDistributedLock(app, { key: 'task', ttlMs: 1234 }, task);

    expect(result.executed).toBe(true);
    expect(runExclusive).toHaveBeenCalledWith(expect.any(Function), 1234);
    expect(task).toHaveBeenCalledOnce();
    process.env.LOCK_ADAPTER_DEFAULT = original;
  });

  it('skips when another node owns the lock', async () => {
    const original = process.env.LOCK_ADAPTER_DEFAULT;
    process.env.LOCK_ADAPTER_DEFAULT = 'redis';
    const error = new Error('lock is locked');
    const app = createApp({
      tryAcquire: async () => {
        throw error;
      },
    });
    const task = vi.fn();

    const result = await runWithDistributedLock(app, { key: 'task' }, task);

    // Generic adapter errors are fail-safe skipped; the task must not run.
    expect(result.executed).toBe(false);
    expect(task).not.toHaveBeenCalled();
    process.env.LOCK_ADAPTER_DEFAULT = original;
  });
  it('treats a missing lock adapter as a loud configuration error, not contention', async () => {
    const original = process.env.LOCK_ADAPTER_DEFAULT;
    process.env.LOCK_ADAPTER_DEFAULT = 'redis';
    // Reproduces LockManager.getAdapter() when the adapter was never registered:
    // this happens when the coordinator plugin loads after the scheduler.
    const app = createApp({
      tryAcquire: async () => {
        throw new Error('Lock adapter "redis" not registered');
      },
    });
    const task = vi.fn();

    const result = await runWithDistributedLock(app, { key: 'cron-job' }, task);

    expect(task).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(result.reason).toBe('adapter-unavailable');
    // Must be reported at error level; a silent skip would hide the fact that
    // no node in the cluster is running this task.
    expect((app as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalled();
    process.env.LOCK_ADAPTER_DEFAULT = original;
  });

  it('reports the lock as unconfigured when the registry lacks the redis adapter', () => {
    const original = process.env.LOCK_ADAPTER_DEFAULT;
    process.env.LOCK_ADAPTER_DEFAULT = 'redis';

    const withAdapter = createApp({ lockManager: { registry: { get: () => class {} } } });
    const withoutAdapter = createApp({ lockManager: { registry: { get: () => undefined } } });

    expect(isDistributedLockConfigured(withAdapter)).toBe(true);
    expect(isDistributedLockConfigured(withoutAdapter)).toBe(false);
    process.env.LOCK_ADAPTER_DEFAULT = original;
  });

  it('reports unconfigured when Redis locking is disabled entirely', () => {
    const original = process.env.LOCK_ADAPTER_DEFAULT;
    delete process.env.LOCK_ADAPTER_DEFAULT;
    const app = createApp({ lockManager: { registry: { get: () => class {} } } });

    expect(isDistributedLockConfigured(app)).toBe(false);
    process.env.LOCK_ADAPTER_DEFAULT = original;
  });
});
