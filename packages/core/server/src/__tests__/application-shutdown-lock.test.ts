/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { LockManager } from '@nocobase/lock-manager';

// Mock the redis client so no real connection (and no sqlite/DB boot) is needed.
// A fresh FakeRedisClient is returned per createClient() call, mirroring the
// lease test, so an "owned" adapter drives a real quit() while a "shared"
// client (injected via redisConnectionManager) is never created here.
class FakeRedisClient {
  isOpen = false;
  on() {
    return this;
  }
  async connect() {
    this.isOpen = true;
  }
  async quit() {
    this.isOpen = false;
  }
  async set() {
    return 'OK';
  }
  async sendCommand() {
    return 1;
  }
}

vi.mock('redis', () => ({
  createClient: () => new FakeRedisClient(),
}));

import { RedisLockAdapter } from '../redis-lock-adapter';
import { Application } from '../application';

describe('Application.disposeServices lock manager teardown', () => {
  // disposeServices is private; invoke it on a hand-built object via the
  // prototype so the ordering logic runs without booting a real Application
  // (which would require sqlite3 and a database).
  const disposeServices = (Application.prototype as unknown as { disposeServices: () => Promise<void> })
    .disposeServices;

  function fakeApp(overrides: Record<string, unknown> = {}) {
    return {
      lockManager: { close: vi.fn(async () => undefined) },
      redisConnectionManager: { close: vi.fn(async () => undefined) },
      cacheManager: { close: vi.fn(async () => undefined) },
      pubSubManager: { close: vi.fn(async () => undefined) },
      telemetry: { started: false },
      workerIdAllocator: { release: vi.fn(async () => undefined) },
      ...overrides,
    };
  }

  it('closes the lock manager exactly once', async () => {
    const app = fakeApp();
    await disposeServices.call(app);
    expect(app.lockManager.close as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it('closes the lock manager before the shared redis connection', async () => {
    const order: string[] = [];
    const app = fakeApp({
      lockManager: {
        close: vi.fn(async () => {
          order.push('lockManager');
        }),
      },
      redisConnectionManager: {
        close: vi.fn(async () => {
          order.push('redisConnectionManager');
        }),
      },
    });

    await disposeServices.call(app);

    expect(order).toEqual(['lockManager', 'redisConnectionManager']);
  });

  it('tolerates a missing lock manager', async () => {
    const app = fakeApp({ lockManager: undefined });
    await expect(disposeServices.call(app)).resolves.toBeUndefined();
  });
});

describe('LockManager.close adapter ownership', () => {
  it('quits an owned redis client and leaves a shared client open', async () => {
    const manager = new LockManager({ defaultAdapter: 'owned' });

    // Owned: a url is configured, so the adapter creates (and must quit) its
    // own client.
    manager.registerAdapter('owned', {
      Adapter: RedisLockAdapter,
      options: { app: { name: 'main' }, url: 'redis://owned' },
    });

    // Shared: no url, so the adapter borrows a client from redisConnectionManager
    // and must NOT quit it on close.
    const sharedClient = new FakeRedisClient();
    await sharedClient.connect();
    const shared = new RedisLockAdapter({
      app: { name: 'main', redisConnectionManager: { getConnection: () => sharedClient as never } },
    });

    // Populate the manager's adapter cache the way getAdapter() would, so
    // close() walks real adapter instances.
    const adapters = (manager as unknown as { adapters: Map<string, unknown> }).adapters;
    // Force construction + connect of the owned adapter through the public API.
    const release = await manager.acquire('probe', 1_000);
    await release();
    const ownedAdapter = adapters.get('owned') as RedisLockAdapter;
    const ownedClient = (ownedAdapter as unknown as { client: FakeRedisClient }).client;
    adapters.set('shared', shared);

    expect(ownedClient.isOpen).toBe(true);
    expect(sharedClient.isOpen).toBe(true);

    await manager.close();

    expect(ownedClient.isOpen).toBe(false);
    expect(sharedClient.isOpen).toBe(true);
  });
});
