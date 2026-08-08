import { describe, expect, it, vi } from 'vitest';

import { RedisSnapshotAdapter } from '../redis-snapshot-adapter';

describe('RedisSnapshotAdapter', () => {
  it('publishes aggregate snapshots with the documented namespace and TTL', async () => {
    const client = { set: vi.fn().mockResolvedValue('OK'), get: vi.fn(), scanIterator: vi.fn() };
    const adapter = new RedisSnapshotAdapter(client, { appName: 'main', ttlSeconds: 30 });
    await adapter.publish({
      schemaVersion: 1,
      appName: 'main',
      nodeId: 'node-1',
      timestamp: 1,
      workerMode: 'web',
      activeUsers: 0,
      runtime: null,
      services: {},
    });
    expect(client.set).toHaveBeenCalledWith('nocobase:main:app-observability:nodes:node-1', expect.any(String), {
      EX: 30,
    });
  });

  it('ignores malformed and stale snapshots', async () => {
    const client = {
      set: vi.fn(),
      scanIterator: vi.fn().mockReturnValue(
        (async function* () {
          yield 'key:1';
          yield 'key:2';
          yield 'key:3';
        })(),
      ),
      get: vi
        .fn()
        .mockResolvedValueOnce('{bad')
        .mockResolvedValueOnce(JSON.stringify({ timestamp: 1, nodeId: 'old' }))
        .mockResolvedValueOnce(
          JSON.stringify({
            schemaVersion: 1,
            appName: 'main',
            nodeId: 'malformed',
            timestamp: 39_000,
            workerMode: 'web',
            activeUsers: 1,
            runtime: null,
            services: null,
          }),
        ),
    };
    const adapter = new RedisSnapshotAdapter(client, { appName: 'main', ttlSeconds: 30, now: () => 40_000 });
    await expect(adapter.list()).resolves.toEqual([]);
  });
});
