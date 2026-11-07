/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { randomUUID } from 'node:crypto';
import type { Application } from '@nocobase/server';
import { createClient } from 'redis';
import { createStartupRecoveryLockClient } from '../../../recovery';
import { RedisLockAdapter } from '../adapters/redis-lock-adapter';

const redisUrl = process.env.STARTUP_GUARDIAN_TEST_REDIS_URL;
const app = { name: 'main', logger: { error: () => undefined } } as unknown as Application;

describe('Cluster Manager recovery lock API with isolated Redis', () => {
  it.skipIf(!redisUrl)('shares one live Redis owner key with RedisLockAdapter', async () => {
    const lockName = `startup-guardian-real:${randomUUID()}`;
    const standalone = createStartupRecoveryLockClient({
      redisUrl,
      appName: 'main',
      lockName,
      ttlMs: 10_000,
    });
    const inspector = createClient({ url: redisUrl });
    const adapter = new RedisLockAdapter({ app, url: redisUrl });
    inspector.on('error', () => undefined);
    await inspector.connect();
    await adapter.connect();
    try {
      const lease = await standalone.tryAcquire('standalone-real-owner-token-01');
      expect(lease).not.toBeNull();
      expect(await inspector.get(`nocobase:main:lock:${lockName}`)).toBe('standalone-real-owner-token-01');
      await expect(adapter.tryAcquire(lockName)).rejects.toThrow('timed out');
      expect(await lease?.verify()).toBe(true);
      await lease?.release();

      const adapterLease = await adapter.tryAcquire(lockName);
      expect(await inspector.get(`nocobase:main:lock:${lockName}`)).toMatch(/^[0-9a-f-]{36}$/i);
      expect(await standalone.tryAcquire('standalone-real-successor-02')).toBeNull();
      await adapterLease.release();
      const next = await standalone.tryAcquire('standalone-real-successor-02');
      expect(next).not.toBeNull();
      expect(await inspector.get(`nocobase:main:lock:${lockName}`)).toBe('standalone-real-successor-02');
      await next?.release();
    } finally {
      await Promise.all([standalone.close(), adapter.close(), inspector.quit()]);
    }
  });
});
