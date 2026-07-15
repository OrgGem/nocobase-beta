import type { Application } from '@nocobase/server';
import { vi } from 'vitest';

const locks = new Map<string, string>();

class FakeRedisClient {
  isOpen = false;
  isReady = false;

  on() {
    return this;
  }

  async connect() {
    this.isOpen = true;
    this.isReady = true;
  }

  async quit() {
    this.isOpen = false;
    this.isReady = false;
  }

  async set(key: string, token: string) {
    if (locks.has(key)) return null;
    locks.set(key, token);
    return 'OK';
  }

  async sendCommand(command: string[]) {
    if (command[0] !== 'EVAL') return null;
    const key = command[3];
    const token = command[4];
    if (locks.get(key) !== token) return 0;
    if (command[1].includes('del')) locks.delete(key);
    return 1;
  }
}

vi.mock('redis', () => ({
  createClient: () => new FakeRedisClient(),
}));

import { RedisLockAdapter } from '../adapters/redis-lock-adapter';

const app = { name: 'main' } as unknown as Application;

describe('RedisLockAdapter', () => {
  beforeEach(() => locks.clear());

  it('allows only one owner and compare-deletes on release', async () => {
    const first = new RedisLockAdapter({ app, url: 'redis://test' });
    const second = new RedisLockAdapter({ app, url: 'redis://test' });
    await first.connect();
    await second.connect();

    const firstLock = await first.tryAcquire('shared-operation');
    await expect(second.tryAcquire('shared-operation')).rejects.toThrow('timed out');
    await firstLock.release();
    const secondLock = await second.tryAcquire('shared-operation');
    await secondLock.release();

    await first.close();
    await second.close();
  });

  it('refuses to renew a lease now owned by another process', async () => {
    const adapter = new RedisLockAdapter({ app, url: 'redis://test' });
    await adapter.connect();
    const lock = await adapter.tryAcquire('lease-race');
    const key = 'nocobase:main:lock:lease-race';
    locks.set(key, 'another-owner');

    await expect(lock.acquire(30_000)).rejects.toThrow('no longer owned');
    await lock.release();
    expect(locks.get(key)).toBe('another-owner');

    await adapter.close();
  });
});
