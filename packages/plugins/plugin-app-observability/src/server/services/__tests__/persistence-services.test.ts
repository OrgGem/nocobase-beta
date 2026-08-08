import { describe, expect, it, vi } from 'vitest';
import type { ServiceSnapshot } from '../../contracts';
import { BucketAggregator } from '../bucket-aggregator';
import { BucketFlushService } from '../bucket-flush-service';
import { RetentionService } from '../retention-service';

function serviceSnapshot(operation: string): ServiceSnapshot {
  return {
    service: 'http',
    operation,
    streaming: false,
    attributes: {},
    inflight: 0,
    maxInflight: 1,
    requestCount: 1,
    successCount: 1,
    failureCount: 0,
    cancelledCount: 0,
    rejectedCount: 0,
    bytesIn: 0,
    bytesOut: 0,
    inputTokens: 0,
    outputTokens: 0,
    latency: { count: 1, sum: 1, max: 1, buckets: [1] },
    firstByte: { count: 0, sum: 0, max: 0, buckets: [] },
  };
}

describe('persistence services', () => {
  it('keeps at most one pending batch after a failed flush', async () => {
    const aggregator = new BucketAggregator({
      appName: 'main',
      nodeId: 'node-1',
      workerMode: 'web',
      bucketSeconds: 60,
    });
    aggregator.record({
      timestamp: 1,
      activeUsers: 0,
      services: { one: serviceSnapshot('x') },
    });
    const repository = { create: vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({}) };
    const service = new BucketFlushService(aggregator, repository);
    await expect(service.flush()).rejects.toThrow('db down');
    await expect(service.flush()).resolves.toBe(1);
    expect(repository.create).toHaveBeenCalledTimes(2);
  });

  it('re-queues only the buckets that were not persisted', async () => {
    const aggregator = new BucketAggregator({
      appName: 'main',
      nodeId: 'node-1',
      workerMode: 'web',
      bucketSeconds: 60,
    });
    aggregator.record({
      timestamp: 1,
      activeUsers: 0,
      services: {
        one: serviceSnapshot('a'),
        two: serviceSnapshot('b'),
        three: serviceSnapshot('c'),
      },
    });
    // First two rows land, the third fails: only the third may be retried.
    const repository = {
      create: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('db down')),
    };
    const service = new BucketFlushService(aggregator, repository);
    await expect(service.flush()).rejects.toThrow('db down');
    expect(repository.create).toHaveBeenCalledTimes(3);

    await expect(service.flush()).resolves.toBe(1);
    expect(repository.create).toHaveBeenCalledTimes(4);
    const retried = repository.create.mock.calls[3][0].values;
    expect(retried.operation).toBe('c');
  });

  it('drains a bucket recorded while another flush is in progress', async () => {
    const aggregator = new BucketAggregator({
      appName: 'main',
      nodeId: 'node-1',
      workerMode: 'web',
      bucketSeconds: 60,
    });
    aggregator.record({ timestamp: 1, activeUsers: 0, services: { first: serviceSnapshot('first') } });
    let releaseFirst: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const repository = {
      create: vi
        .fn()
        .mockImplementationOnce(async () => firstWrite)
        .mockResolvedValue({}),
    };
    const service = new BucketFlushService(aggregator, repository);
    const activeFlush = service.flush();
    aggregator.record({ timestamp: 1, activeUsers: 0, services: { second: serviceSnapshot('second') } });
    releaseFirst?.();

    await expect(activeFlush).resolves.toBe(1);
    await expect(service.flushAndDrain()).resolves.toBe(1);
    expect(repository.create).toHaveBeenCalledTimes(2);
    expect(repository.create.mock.calls[1][0].values).toMatchObject({ operation: 'second' });
  });

  it('deletes old buckets and only resolved alerts in bounded batches', async () => {
    const buckets = { destroy: vi.fn().mockResolvedValueOnce(500).mockResolvedValueOnce(2) };
    const alerts = { destroy: vi.fn().mockResolvedValue(1) };
    await expect(
      new RetentionService(buckets, alerts, () => Date.parse('2026-08-05T00:00:00Z')).cleanup(14),
    ).resolves.toEqual({ buckets: 502, alerts: 1 });
    expect(alerts.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.objectContaining({ status: 'resolved' }) }),
    );
  });
});
