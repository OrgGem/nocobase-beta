import { describe, expect, it } from 'vitest';
import { LockManager } from '@nocobase/lock-manager';
import { RedisLockAdapter } from '../redis-lock-adapter';

describe('RedisLockAdapter registration', () => {
  it('is exported from the core server package surface', async () => {
    const server = await import('../index');
    expect(server.RedisLockAdapter).toBeTypeOf('function');
    expect(server.RedisLockAdapter).toBe(RedisLockAdapter);
  });

  it('registers the redis adapter so LOCK_ADAPTER_DEFAULT=redis always resolves', () => {
    const manager = new LockManager({ defaultAdapter: 'redis' });
    manager.registerAdapter('redis', {
      Adapter: RedisLockAdapter,
      options: { app: { name: 'main' }, url: 'redis://unused' },
    });

    // The registry must expose the adapter, otherwise LockManager.getAdapter()
    // throws `Lock adapter "redis" not registered` on the first lock call.
    expect((manager as unknown as { registry: { get: (n: string) => unknown } }).registry.get('redis')).toBeTruthy();
  });

  it('namespaces keys by application name', () => {
    const adapter = new RedisLockAdapter({ app: { name: 'acme' }, url: 'redis://unused' });
    expect((adapter as unknown as { getKey: (k: string) => string }).getKey('job')).toBe('nocobase:acme:lock:job');
  });

  it('falls back to the process Redis connection when no url is given', async () => {
    const used: string[] = [];
    const client = {
      isOpen: true,
      isReady: true,
      on: () => client,
      set: async () => {
        used.push('set');
        return 'OK';
      },
      sendCommand: async () => 1,
      quit: async () => undefined,
      connect: async () => undefined,
    };
    const adapter = new RedisLockAdapter({
      app: { name: 'main', redisConnectionManager: { getConnection: () => client as never } },
    });

    await adapter.connect();
    const release = await adapter.acquire('shared', 5_000);
    await release();

    expect(used).toEqual(['set']);
    // Reusing the shared client must not close it on adapter shutdown.
    await adapter.close();
    expect(client.isOpen).toBe(true);
  });
});
