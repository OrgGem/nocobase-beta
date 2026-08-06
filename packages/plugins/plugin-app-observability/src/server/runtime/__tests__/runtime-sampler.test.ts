import { describe, expect, it } from 'vitest';

import { RuntimeSampler } from '../runtime-sampler';

describe('RuntimeSampler', () => {
  it('returns nullable deltas for the first sample and computed values later', () => {
    let now = 1_000;
    let cpu = { user: 100_000, system: 50_000 };
    let elu = { active: 10, idle: 90, utilization: 0.1 };
    const sampler = new RuntimeSampler({
      now: () => now,
      cpuCount: () => 2,
      cpuUsage: () => cpu,
      memoryUsage: () => ({ rss: 100, heapTotal: 80, heapUsed: 50, external: 10, arrayBuffers: 5 }),
      eventLoopUtilization: () => elu,
      eventLoopDelay: {
        sample: () => ({ p50: 1, p95: 2, p99: 3, max: 4 }),
        reset: () => undefined,
        stop: () => undefined,
      },
    });
    expect(sampler.sample()).toMatchObject({ cpuPercent: null, eventLoopUtilization: null, rssBytes: 100 });
    now = 2_000;
    cpu = { user: 300_000, system: 250_000 };
    elu = { active: 40, idle: 160, utilization: 0.2 };
    expect(sampler.sample()).toMatchObject({ cpuPercent: 20, eventLoopUtilization: 30 / 100 });
    sampler.stop();
  });
});
