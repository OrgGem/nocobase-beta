import { describe, expect, it, vi } from 'vitest';
import { BucketAggregator } from '../bucket-aggregator';
import { BucketFlushService } from '../bucket-flush-service';
import { RetentionService } from '../retention-service';

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
      services: {
        one: {
          service: 'http',
          operation: 'x',
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
        },
      },
    });
    const repository = { create: vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue({}) };
    const service = new BucketFlushService(aggregator, repository);
    await expect(service.flush()).rejects.toThrow('db down');
    await expect(service.flush()).resolves.toBe(1);
    expect(repository.create).toHaveBeenCalledTimes(2);
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
