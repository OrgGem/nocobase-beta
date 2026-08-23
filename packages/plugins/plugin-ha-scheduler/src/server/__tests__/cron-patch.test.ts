import { describe, expect, it, vi } from 'vitest';
import { installCronPatch } from '../cron-patch';

function createCronManager() {
  const jobs: Array<{ onTick?: (...args: unknown[]) => unknown }> = [];
  const manager = {
    addJob: vi.fn((options: { onTick?: (...args: unknown[]) => unknown }) => {
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

describe('installCronPatch', () => {
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
});
