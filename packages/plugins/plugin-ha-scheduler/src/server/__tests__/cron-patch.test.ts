import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addHaCronJob, installCronPatch } from '../cron-patch';

type TickFn = (...args: unknown[]) => unknown;

function createCronManager() {
  const jobs: Array<{ onTick?: TickFn }> = [];
  const manager = {
    addJob: vi.fn((options: { onTick?: TickFn }) => {
      const job = { onTick: options.onTick };
      jobs.push(job);
      return job;
    }),
    jobs,
    start: vi.fn(),
    stop: vi.fn(),
  };
  return manager;
}

/**
 * A fake lock manager that records the keys it was asked to lock and lets the
 * task run. This is what lets a test observe which key a wrapped cron tick uses.
 */
function createRecordingApp() {
  const acquiredKeys: string[] = [];
  const manager = createCronManager();
  const app = {
    cronJobManager: manager,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    lockManager: {
      tryAcquire: vi.fn(async (key: string) => {
        acquiredKeys.push(key);
        return {
          runExclusive: async <T>(task: () => Promise<T>) => task(),
        };
      }),
    },
  } as never;
  return { app, manager, acquiredKeys };
}

describe('installCronPatch', () => {
  beforeEach(() => {
    process.env.LOCK_ADAPTER_DEFAULT = 'redis';
  });

  afterEach(() => {
    delete process.env.LOCK_ADAPTER_DEFAULT;
  });

  it('wraps cron callbacks registered after installation', async () => {
    const manager = createCronManager();
    const app = {
      cronJobManager: manager,
      logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
      lockManager: undefined,
    } as never;
    const restore = installCronPatch(app);
    const callback = vi.fn();

    manager.addJob({ cronTime: '*/5 * * * * *', onTick: callback });
    await manager.jobs[0].onTick?.();

    expect(callback).toHaveBeenCalledOnce();
    restore();
    expect(manager.addJob).not.toBeUndefined();
  });

  it('derives the same lock key for a job regardless of registration order across nodes', async () => {
    // The core bug this guards: two nodes register the SAME set of jobs but in a
    // different order. With the old per-process jobIndex, each node computed a
    // different key for the same job and both nodes then ran it. The key must be
    // stable per job, order-independent.
    const jobA = { cronTime: '0 * * * * *', onTick: () => 'alpha task body' };
    const jobB = { cronTime: '0 * * * * *', onTick: () => 'beta task body' };

    const node1 = createRecordingApp();
    installCronPatch(node1.app);
    node1.manager.addJob(jobA);
    node1.manager.addJob(jobB);

    const node2 = createRecordingApp();
    installCronPatch(node2.app);
    // Opposite registration order.
    node2.manager.addJob(jobB);
    node2.manager.addJob(jobA);

    // Fire both jobs on each node.
    for (const job of node1.manager.jobs) await job.onTick?.();
    for (const job of node2.manager.jobs) await job.onTick?.();

    const keyForA1 = node1.acquiredKeys[0];
    const keyForB1 = node1.acquiredKeys[1];
    // node2 registered B first, then A.
    const keyForB2 = node2.acquiredKeys[0];
    const keyForA2 = node2.acquiredKeys[1];

    // Same logical job => same key on both nodes, despite opposite order.
    expect(keyForA1).toBe(keyForA2);
    expect(keyForB1).toBe(keyForB2);
    // Different jobs sharing one expression => distinct keys.
    expect(keyForA1).not.toBe(keyForB1);
  });

  it('honors an explicit haLockKey and strips it before core sees the options', async () => {
    const { app, manager, acquiredKeys } = createRecordingApp();
    // installCronPatch replaces manager.addJob with a wrapper, so capture the
    // original spy first to inspect the options that actually reach core.
    const originalAddJob = manager.addJob;
    installCronPatch(app);

    // Use the type-safe helper rather than casting addJob's CronJobParameters.
    addHaCronJob(app, { cronTime: '0 * * * * *', onTick: () => undefined, haLockKey: 'nightly-report' });
    await manager.jobs[0].onTick?.();

    // runWithDistributedLock namespaces every key under "ha-scheduler:".
    expect(acquiredKeys[0]).toBe('ha-scheduler:cron:key:nightly-report');
    // The ha-scheduler-only field must not leak into the options handed to core.
    const forwarded = originalAddJob.mock.calls[0][0] as Record<string, unknown>;
    expect('haLockKey' in forwarded).toBe(false);
  });

  it('distinguishes structurally different jobs that share an expression via the tick body hash', async () => {
    const { app, manager, acquiredKeys } = createRecordingApp();
    installCronPatch(app);

    manager.addJob({ cronTime: '*/10 * * * * *', onTick: () => 'first' });
    manager.addJob({ cronTime: '*/10 * * * * *', onTick: () => 'second' });

    for (const job of manager.jobs) await job.onTick?.();

    expect(acquiredKeys[0]).not.toBe(acquiredKeys[1]);
  });
});
