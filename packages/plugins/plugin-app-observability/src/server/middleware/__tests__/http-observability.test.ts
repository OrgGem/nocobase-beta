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

  // This middleware is installed before `resourcer`, so ctx.action is only assigned
  // while next() runs. The final series must still be the canonical resource action.
  it('adopts the resource action that resourcer resolves during next()', async () => {
    const store = new MetricsStore({ appName: 'main', nodeId: 'node-1' });
    const response = new EventEmitter() as EventEmitter & { writableEnded: boolean };
    response.writableEnded = true;
    const middleware = createHttpObservabilityMiddleware(store);
    const ctx: Parameters<typeof middleware>[0] = { path: '/api/users:get/42', status: 200, res: response };
    await middleware(ctx, async () => {
      ctx.action = { resourceName: 'users', actionName: 'get' };
    });
    const services = Object.values(store.getSnapshot().services);
    expect(services).toHaveLength(1);
    expect(services[0]).toMatchObject({ operation: 'users:get', requestCount: 1, successCount: 1, inflight: 0 });
  });

  it('does not instrument its own observability endpoints', async () => {
    const store = new MetricsStore({ appName: 'main', nodeId: 'node-1' });
    const response = new EventEmitter() as EventEmitter & { writableEnded: boolean };
    response.writableEnded = true;
    const middleware = createHttpObservabilityMiddleware(store);
    await middleware({ path: '/api/appObservability:overview', status: 200, res: response }, async () => undefined);
    expect(Object.values(store.getSnapshot().services)).toHaveLength(0);
  });

  it('forwards authenticated users to the cluster cardinality sink', async () => {
    const store = new MetricsStore({ appName: 'main', nodeId: 'node-1' });
    const response = new EventEmitter() as EventEmitter & { writableEnded: boolean };
    response.writableEnded = true;
    const observed: Array<string | number> = [];
    const middleware = createHttpObservabilityMiddleware(store, {
      onActiveUser: async (identifier) => {
        observed.push(identifier);
      },
    });
    await middleware(
      {
        action: { resourceName: 'users', actionName: 'list' },
        path: '/api/users:list',
        status: 200,
        res: response,
        state: { currentUser: { id: 'user-42' } },
      },
      async () => undefined,
    );
    expect(observed).toEqual(['user-42']);
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
