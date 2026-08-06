import { describe, expect, it } from 'vitest';

import { MetricsStore } from '../metrics-store';

describe('MetricsStore', () => {
  it('tracks inflight, outcomes, tokens, bytes and first byte once', () => {
    let now = 1_000;
    const store = new MetricsStore({ appName: 'main', nodeId: 'node-1', now: () => now });
    const handle = store.start({ service: 'llm.chat', operation: 'chat', streaming: true });
    expect(Object.values(store.getSnapshot().services)[0].inflight).toBe(1);
    now = 1_120;
    handle.markFirstByte();
    handle.markFirstByte();
    handle.addInputTokens(10);
    handle.addOutputTokens(4);
    now = 1_300;
    handle.finish({ status: 'cancelled', bytesIn: 12, bytesOut: 34 });

    const service = Object.values(store.getSnapshot().services)[0];
    expect(service).toMatchObject({
      requestCount: 1,
      cancelledCount: 1,
      inflight: 0,
      inputTokens: 10,
      outputTokens: 4,
      bytesIn: 12,
      bytesOut: 34,
    });
    expect(service.firstByte.count).toBe(1);
    expect(service.latency.count).toBe(1);
  });

  it('expires active users and never serializes identifiers', () => {
    let now = 0;
    const store = new MetricsStore({
      appName: 'main',
      nodeId: 'node-1',
      activeUserWindowMs: 1_000,
      now: () => now,
    });
    store.observeActiveUser('user-42');
    expect(store.getSnapshot().activeUsers).toBe(1);
    expect(JSON.stringify(store.getSnapshot())).not.toContain('user-42');
    now = 1_001;
    expect(store.getSnapshot().activeUsers).toBe(0);
  });

  it('bounds service cardinality and sanitizes attributes', () => {
    const store = new MetricsStore({ appName: 'main', nodeId: 'node-1', maxSeries: 2 });
    for (const operation of ['one', 'two', 'three']) {
      store
        .start({
          service: 'custom',
          operation,
          attributes: { model: 'safe', userId: 'secret', requestId: 'secret' },
        })
        .finish({ status: 'succeeded' });
    }
    const snapshot = store.getSnapshot();
    expect(Object.keys(snapshot.services)).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
  });
});
