import { EventEmitter } from 'events';
import { describe, expect, it } from 'vitest';
import { MetricsStore } from '../../metrics/metrics-store';
import { createHttpObservabilityMiddleware } from '../http-observability';

describe('HTTP observability middleware', () => {
  it('records successful resource actions and active users without request content', async () => {
    const store = new MetricsStore({ appName: 'main', nodeId: 'node-1' });
    const response = new EventEmitter() as EventEmitter & { writableEnded: boolean };
    response.writableEnded = true;
    const middleware = createHttpObservabilityMiddleware(store);
    await middleware(
      {
        action: { resourceName: 'users', actionName: 'list' },
        path: '/api/users:list',
        status: 200,
        res: response,
        state: { currentUser: { id: 42 } },
      },
      async () => undefined,
    );
    const snapshot = store.getSnapshot();
    expect(snapshot.activeUsers).toBe(1);
    expect(Object.values(snapshot.services)[0]).toMatchObject({ operation: 'users:list', successCount: 1 });
    expect(JSON.stringify(snapshot)).not.toContain('42');
  });

  it('waits for an SSE close and marks an aborted client cancelled', async () => {
    const store = new MetricsStore({ appName: 'main', nodeId: 'node-1' });
    const response = new EventEmitter() as EventEmitter & { writableEnded: boolean };
    response.writableEnded = false;
    const middleware = createHttpObservabilityMiddleware(store);
    await middleware(
      { path: '/stream/1', status: 200, type: 'text/event-stream', res: response },
      async () => undefined,
    );
    expect(Object.values(store.getSnapshot().services)[0].inflight).toBe(1);
    response.emit('close');
    expect(Object.values(store.getSnapshot().services)[0]).toMatchObject({ inflight: 0, cancelledCount: 1 });
  });
});
