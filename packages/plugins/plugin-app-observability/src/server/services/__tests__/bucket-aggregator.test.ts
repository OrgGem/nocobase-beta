import { describe, expect, it } from 'vitest';

import { BucketAggregator } from '../bucket-aggregator';

describe('BucketAggregator', () => {
  it('snapshots and resets metrics atomically', () => {
    const aggregator = new BucketAggregator({
      appName: 'main',
      nodeId: 'node-1',
      workerMode: 'web',
      bucketSeconds: 60,
    });
    aggregator.record({
      timestamp: 65_000,
      activeUsers: 2,
      services: {
        'http|users:list|0': {
          service: 'http',
          operation: 'users:list',
          streaming: false,
          attributes: {},
          inflight: 0,
          maxInflight: 2,
          requestCount: 3,
          successCount: 2,
          failureCount: 1,
          cancelledCount: 0,
          rejectedCount: 0,
          bytesIn: 10,
          bytesOut: 20,
          inputTokens: 0,
          outputTokens: 0,
          latency: { count: 3, sum: 30, max: 20, buckets: [0, 1] },
          firstByte: { count: 0, sum: 0, max: 0, buckets: [] },
        },
      },
    });
    const buckets = aggregator.snapshotAndReset();
    expect(buckets[0]).toMatchObject({ bucketStart: 60_000, requestCount: 3, uniqueUserEstimate: 2 });
    expect(aggregator.snapshotAndReset()).toEqual([]);
  });
});
