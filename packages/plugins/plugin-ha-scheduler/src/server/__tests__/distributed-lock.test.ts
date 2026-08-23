import { describe, expect, it, vi } from 'vitest';
import { runWithDistributedLock } from '../distributed-lock';

function createApp(options: {
  lockDefault?: string;
  tryAcquire?: (
    key: string,
    timeout?: number,
  ) => Promise<{ runExclusive: <T>(task: () => Promise<T>, ttl: number) => Promise<T> }>;
}) {
  const logger = { debug: vi.fn(), warn: vi.fn() };
  return {
    lockManager: options.tryAcquire ? { tryAcquire: options.tryAcquire } : undefined,
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
});
