import { describe, expect, it } from 'vitest';
import { CapacityLimiter, queueTimeoutError } from '../services/capacity-limiter';

function createLimiter(overrides: Partial<ConstructorParameters<typeof CapacityLimiter>[0]> = {}) {
  return new CapacityLimiter({
    maxConcurrentRequests: 2,
    maxTotalBytes: 10,
    maxRequestBytes: 0,
    queueEnabled: true,
    queueSize: 10,
    queueTimeoutMs: 1000,
    ...overrides,
  });
}

describe('CapacityLimiter', () => {
  it('admits requests while capacity is available', async () => {
    const limiter = createLimiter();
    const a = await limiter.acquire(3);
    const b = await limiter.acquire(4);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(limiter.getStats()).toMatchObject({ activeRequests: 2, activeBytes: 7, queuedRequests: 0 });
    a.release();
    b.release();
  });

  it('rejects an oversized single request with 413 body-too-large', async () => {
    const limiter = new CapacityLimiter({
      maxConcurrentRequests: 10,
      maxTotalBytes: 0,
      maxRequestBytes: 100,
      queueEnabled: true,
      queueSize: 10,
      queueTimeoutMs: 1000,
    });
    await expect(limiter.acquire(101)).rejects.toMatchObject({ httpStatus: 413 });
  });

  it('rejects immediately when at capacity and the queue is full', async () => {
    const limiter = new CapacityLimiter({
      maxConcurrentRequests: 1,
      maxTotalBytes: 10,
      maxRequestBytes: 0,
      queueEnabled: true,
      queueSize: 1,
      queueTimeoutMs: 5000,
    });
    const first = await limiter.acquire(10);
    const queued = limiter.acquire(10);
    await expect(limiter.acquire(10)).rejects.toMatchObject({ httpStatus: 429 });
    first.release();
    await queued;
  });

  it('rejects immediately when queueing is disabled and at capacity', async () => {
    const limiter = createLimiter({ queueEnabled: false, maxConcurrentRequests: 1, maxTotalBytes: 10 });
    const first = await limiter.acquire(10);
    await expect(limiter.acquire(1)).rejects.toMatchObject({ httpStatus: 429 });
    first.release();
  });

  it('queues and admits a waiter after capacity frees up', async () => {
    const limiter = createLimiter({ maxConcurrentRequests: 1, maxTotalBytes: 10 });
    const first = await limiter.acquire(10);
    const waiterPromise = limiter.acquire(10);
    expect(limiter.getStats().queuedRequests).toBe(1);
    first.release();
    const lease = await waiterPromise;
    expect(lease.getWaitDecision().queuedMs).not.toBeNull();
    expect(limiter.getStats().activeRequests).toBe(1);
    lease.release();
  });

  it('rejects a queued request after the queue timeout', async () => {
    const limiter = createLimiter({ maxConcurrentRequests: 1, maxTotalBytes: 10, queueTimeoutMs: 20 });
    const first = await limiter.acquire(10);
    await expect(limiter.acquire(10)).rejects.toThrow(queueTimeoutError().message);
    first.release();
  });

  it('released capacity is restored', async () => {
    const limiter = createLimiter({ maxConcurrentRequests: 1, maxTotalBytes: 10 });
    const first = await limiter.acquire(10);
    first.release();
    expect(limiter.getStats().activeRequests).toBe(0);
    expect(limiter.getStats().activeBytes).toBe(0);
  });
});
