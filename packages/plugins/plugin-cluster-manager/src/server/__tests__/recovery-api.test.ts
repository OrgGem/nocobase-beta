/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { readFile } from 'node:fs/promises';
import { vi } from 'vitest';
import type { Application } from '@nocobase/server';

const locks = new Map<string, string>();

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

import { createStartupRecoveryLockClient, STARTUP_RECOVERY_LOCK_API_VERSION } from '../../../recovery';
import { RedisLockAdapter } from '../adapters/redis-lock-adapter';

const app = { name: 'main', logger: { error: vi.fn() } } as unknown as Application;

describe('Cluster Manager standalone recovery lock API', () => {
  beforeEach(() => locks.clear());

  it('uses the existing app lock namespace and rejects a competing owner', async () => {
    const first = createStartupRecoveryLockClient({
      client: new FakeRedisClient(),
      appName: 'main',
      lockName: 'startup-guardian:prod',
    });
    const second = createStartupRecoveryLockClient({
      client: new FakeRedisClient(),
      appName: 'main',
      lockName: 'startup-guardian:prod',
    });
    expect(first.apiVersion).toBe(STARTUP_RECOVERY_LOCK_API_VERSION);
    expect(first.key).toBe('nocobase:main:lock:startup-guardian:prod');
    const firstLease = await first.tryAcquire('first-owner-token-0001');
    expect(firstLease).not.toBeNull();
    expect(await second.tryAcquire('second-owner-token-0002')).toBeNull();
    expect(await firstLease?.verify()).toBe(true);
    expect(await firstLease?.renew()).toBe(true);
    await firstLease?.release();
    const secondLease = await second.tryAcquire('second-owner-token-0002');
    expect(secondLease).not.toBeNull();
    await secondLease?.release();
    await Promise.all([first.close(), second.close()]);
  });

  it('rejects stale verification and release after another token takes the Redis key', async () => {
    const client = createStartupRecoveryLockClient({
      client: new FakeRedisClient(),
      appName: 'main',
      lockName: 'startup-guardian:stale',
    });
    const lease = await client.tryAcquire('first-owner-token-0001');
    expect(lease).not.toBeNull();
    locks.set(client.key, 'second-owner-token-0002');
    expect(await lease?.verify()).toBe(false);
    expect(await lease?.renew()).toBe(false);
    expect(await lease?.release()).toBe(false);
    expect(locks.get(client.key)).toBe('second-owner-token-0002');
    await client.close();
  });

  it('shares locks with the existing RedisLockAdapter and preserves compare-owner semantics', async () => {
    const lockName = 'startup-guardian:prod';
    const standalone = createStartupRecoveryLockClient({ client: new FakeRedisClient(), appName: 'main', lockName });
    const adapter = new RedisLockAdapter({ app, url: 'redis://test' });
    await adapter.connect();

    const lease = await standalone.tryAcquire('standalone-owner-token-01');
    expect(lease).not.toBeNull();
    await expect(adapter.tryAcquire(lockName)).rejects.toThrow('timed out');
    await lease?.release();

    const adapterLock = await adapter.tryAcquire(lockName);
    const sharedKey = 'nocobase:main:lock:startup-guardian:prod';
    expect(locks.get(sharedKey)).toBeTruthy();
    locks.set(sharedKey, 'successor-owner-token-02');
    await expect(adapterLock.acquire(30_000)).rejects.toThrow('no longer owned');
    await adapterLock.release();
    expect(locks.get(sharedKey)).toBe('successor-owner-token-02');

    await Promise.all([standalone.close(), adapter.close()]);
  });

  it('loads from a core-free package subpath implementation', async () => {
    const sources = await Promise.all([
      readFile(new URL('../../../recovery.js', import.meta.url), 'utf8'),
      readFile(new URL('../../../redis-lock-core.js', import.meta.url), 'utf8'),
    ]);
    expect(sources.join('\n')).not.toContain('@nocobase/server');
    expect(sources.join('\n')).not.toContain('@nocobase/app');
  });
});
