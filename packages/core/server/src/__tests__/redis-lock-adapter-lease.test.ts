import { describe, expect, it, vi } from 'vitest';

const locks = new Map<string, string>();
const scripts = new Map<string, string>();
let scriptSeq = 0;

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

  destroy() {
    this.isOpen = false;
    this.isReady = false;
  }

  async set(key: string, token: string) {
    if (locks.has(key)) return null;
    locks.set(key, token);
    return 'OK';
  }

  async sendCommand(command: string[]) {
    const [name] = command;
    if (name === 'SCRIPT') {
      const sha = `sha${++scriptSeq}`;
      scripts.set(sha, command[2]);
      return sha;
    }
    if (name === 'EVAL') {
      return this.runScript(command[1], command[3], command[4]);
    }
    if (name === 'EVALSHA') {
      const body = scripts.get(command[1]);
      if (!body) throw new Error('NOSCRIPT No matching script');
      return this.runScript(body, command[3], command[4]);
    }
    throw new Error(`FakeRedisClient: unsupported command ${name}`);
  }

  private runScript(body: string, key: string, token: string) {
    if (locks.get(key) !== token) return 0;
    if (body.includes('del')) locks.delete(key);
    return 1;
  }
}

vi.mock('redis', () => ({
  createClient: () => new FakeRedisClient(),
}));

import { RedisLockAdapter } from '../redis-lock-adapter';

const app = { name: 'main' };

describe('RedisLockAdapter lease ownership', () => {
  it('allows only one owner and compare-deletes on release', async () => {
    locks.clear();
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
    locks.clear();
    const adapter = new RedisLockAdapter({ app, url: 'redis://test' });
    await adapter.connect();
    const lock = await adapter.tryAcquire('lease-race');
    const key = 'nocobase:main:lock:lease-race';

    // Simulate the lease expiring and another node taking it over.
    locks.set(key, 'another-owner');

    await expect(lock.acquire(30_000)).rejects.toThrow('no longer owned');
    await lock.release();
    expect(locks.get(key)).toBe('another-owner');

    await adapter.close();
  });

  it('recovers when Redis reports NOSCRIPT after a restart', async () => {
    locks.clear();
    scripts.clear();
    const adapter = new RedisLockAdapter({ app, url: 'redis://test' });
    await adapter.connect();

    const release = await adapter.acquire('after-restart', 5_000);
    // Simulate a failover that dropped the cached script.
    scripts.clear();
    await expect(release()).resolves.toBeUndefined();
    expect(locks.size).toBe(0);

    await adapter.close();
  });
});
