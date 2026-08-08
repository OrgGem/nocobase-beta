import { describe, expect, it, vi } from 'vitest';
import type { CapacityAssessment } from '../../capacity/types';
import type { NodeObservabilitySnapshot } from '../../contracts';
import type { RedisSnapshotAdapter } from '../../adapters/redis-snapshot-adapter';
import { QueryService } from '../query-service';

function snapshot(nodeId: string, activeUsers: number, requestCount: number): NodeObservabilitySnapshot {
  return {
    schemaVersion: 1,
    appName: 'main',
    nodeId,
    timestamp: 1_000,
    workerMode: 'web',
    activeUsers,
    runtime: null,
    services: {
      'http|users:list|0|{}': {
        service: 'http',
        operation: 'users:list',
        streaming: false,
        attributes: {},
        inflight: 0,
        maxInflight: 1,
        requestCount,
        successCount: requestCount,
        failureCount: 0,
        cancelledCount: 0,
        rejectedCount: 0,
        bytesIn: 0,
        bytesOut: 0,
        inputTokens: 0,
        outputTokens: 0,
        latency: { count: 0, sum: 0, max: 0, buckets: [] },
        firstByte: { count: 0, sum: 0, max: 0, buckets: [] },
      },
    },
  };
}
function serviceOf(contract: NodeObservabilitySnapshot) {
  return {
    getNodeSnapshot: () => contract,
    getCapacityAssessment: vi.fn(),
    start: vi.fn(),
    observe: vi.fn(),
    registerService: vi.fn(),
  };
}

describe('QueryService', () => {
  // The local node publishes itself to Redis, so Redis always holds a slightly
  // stale copy of it. The live in-memory snapshot has to win.
  it('prefers the live local snapshot over its own stale Redis copy', async () => {
    const live = snapshot('node-1', 9, 100);
    const stale = snapshot('node-1', 2, 40);
    const adapter = { list: async () => [stale] } as unknown as RedisSnapshotAdapter;
    const query = new QueryService(serviceOf(live), { find: async () => [] }, () => adapter);

    const nodes = await query.nodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].activeUsers).toBe(9);
    expect(Object.values(nodes[0].services)[0].requestCount).toBe(100);
  });

  it('keeps the active-user result node-local until Redis cardinality is available', async () => {
    const adapter = { list: async () => [snapshot('node-2', 3, 10)] } as unknown as RedisSnapshotAdapter;
    const query = new QueryService(
      serviceOf(snapshot('node-1', 5, 20)),
      { find: async () => [] },
      () => adapter,
      () => 900,
    );

    const overview = await query.overview();
    expect(overview).toMatchObject({
      nodes: 2,
      activeUsers: 5,
      activeUserScope: 'node-local',
      aggregationMode: 'redis',
      sessionWindowSeconds: 900,
    });
    expect(overview.http).toMatchObject({ requestCount: 30 });
  });

  it('uses the Redis cardinality estimate when it is available', async () => {
    const adapter = { list: async () => [snapshot('node-2', 3, 10)] } as unknown as RedisSnapshotAdapter;
    const query = new QueryService(
      serviceOf(snapshot('node-1', 5, 20)),
      { find: async () => [] },
      () => adapter,
      () => 300,
      undefined,
      async () => 6,
    );
    await expect(query.overview()).resolves.toMatchObject({ activeUsers: 6, activeUserScope: 'cluster-estimate' });
  });

  it('returns the most constrained node for cluster capacity', async () => {
    const local = snapshot('node-1', 5, 20);
    const remote = snapshot('node-2', 3, 10);
    const adapter = { list: async () => [remote] } as unknown as RedisSnapshotAdapter;
    const healthy: CapacityAssessment = {
      state: 'healthy',
      confidence: 1,
      constrainingSignal: 'cpu',
      signals: [{ key: 'cpu', utilization: 20, headroom: 80, reliable: true, evidence: { key: 'ok' } }],
      evidence: [],
      recommendation: { key: 'ok' },
      thresholdCrossingAt: null,
      calibration: null,
    };
    const critical: CapacityAssessment = {
      ...healthy,
      state: 'critical',
      signals: [{ key: 'cpu', utilization: 140, headroom: 0, reliable: true, evidence: { key: 'high' } }],
    };
    const query = new QueryService(
      serviceOf(local),
      { find: async () => [] },
      () => adapter,
      undefined,
      (node) => (node.nodeId === 'node-2' ? critical : healthy),
    );
    await expect(query.capacity()).resolves.toMatchObject({
      state: 'critical',
      assessedNodeId: 'node-2',
      nodeCount: 2,
    });
  });

  it('falls back to single-node mode when Redis is unavailable', async () => {
    const query = new QueryService(serviceOf(snapshot('node-1', 4, 7)), { find: async () => [] }, () => null);
    await expect(query.overview()).resolves.toMatchObject({ aggregationMode: 'single-node', nodes: 1 });
  });
});
