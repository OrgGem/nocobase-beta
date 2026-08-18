import { ILockAdapter, ILock, Releaser, LockAcquireError, LockAbortError } from '@nocobase/lock-manager';
import { randomUUID } from 'crypto';
import type { Application, Redis } from '@nocobase/server';
import { createClient } from 'redis';

const RELEASE_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const RENEW_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

export class RedisLockAdapter implements ILockAdapter {
  private readonly client: Redis;
  private readonly ownsClient: boolean;

  constructor(private readonly options: { url?: string; app: Application }) {
    if (options.url) {
      this.client = createClient({ url: options.url });
      // Without an 'error' listener, any connection failure emits an unhandled
      // 'error' event and crashes the Node process.
      this.client.on('error', (error) => {
        options.app.logger.error(`[RedisLockAdapter] Redis error: ${error.message}`);
      });
      this.ownsClient = true;
    } else {
      const client = options.app.redisConnectionManager?.getConnection();
      if (!client) throw new Error('[RedisLockAdapter] Redis client not found or unavailable');
      this.client = client;
      this.ownsClient = false;
    }
  }

  async connect(): Promise<void> {
    if (!this.client.isOpen) await this.client.connect();
  }

  async close(): Promise<void> {
    if (this.ownsClient && this.client.isOpen) await this.client.quit();
  }

  async acquire(key: string, ttl: number): Promise<Releaser> {
    const token = randomUUID();
    const redisKey = this.getKey(key);
    const startedAt = Date.now();
    const maxWaitMs = Math.min(Math.max(ttl, 1), 30_000);

    while (Date.now() - startedAt <= maxWaitMs) {
      const result = await this.client.set(redisKey, token, { NX: true, PX: ttl });
      if (result === 'OK') return this.createReleaser(redisKey, token);
      await this.sleep(50);
    }
    throw new LockAcquireError(`Lock acquire timed out after ${maxWaitMs}ms for key ${key}`);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>, ttl: number): Promise<T> {
    const token = randomUUID();
    const redisKey = this.getKey(key);
    await this.acquireWithToken(redisKey, token, ttl, Math.min(Math.max(ttl, 1), 30_000));
    const release = this.createReleaser(redisKey, token);
    let leaseError: Error | null = null;
    const renewInterval = Math.max(100, Math.floor(ttl / 3));
    const timer = setInterval(() => {
      this.renew(redisKey, token, ttl)
        .then(() => {
          // A successful renewal heals any earlier transient failure.
          leaseError = null;
        })
        .catch((error: unknown) => {
          leaseError = error instanceof Error ? error : new Error(String(error));
        });
    }, renewInterval);
    timer.unref?.();

    try {
      const result = await fn();
      if (leaseError) throw new LockAbortError('Distributed lock lease was lost', { cause: leaseError });
      return result;
    } finally {
      clearInterval(timer);
      await release();
    }
  }

  async tryAcquire(key: string, timeout = 0): Promise<ILock> {
    const token = randomUUID();
    const redisKey = this.getKey(key);
    const initialTtl = Math.max(timeout, 10_000);
    await this.acquireWithToken(redisKey, token, initialTtl, timeout);
    const release = this.createReleaser(redisKey, token);

    return {
      release,
      acquire: async (ttl: number) => {
        await this.renew(redisKey, token, ttl);
        return release;
      },
      runExclusive: async <T>(fn: () => Promise<T>, ttl: number) => {
        await this.renew(redisKey, token, ttl);
        let leaseError: Error | null = null;
        const timer = setInterval(
          () => {
            this.renew(redisKey, token, ttl)
              .then(() => {
                // A successful renewal heals any earlier transient failure.
                leaseError = null;
              })
              .catch((error: unknown) => {
                leaseError = error instanceof Error ? error : new Error(String(error));
              });
          },
          Math.max(100, Math.floor(ttl / 3)),
        );
        timer.unref?.();
        try {
          const result = await fn();
          if (leaseError) throw new LockAbortError('Distributed lock lease was lost', { cause: leaseError });
          return result;
        } finally {
          clearInterval(timer);
          await release();
        }
      },
    };
  }

  private async acquireWithToken(redisKey: string, token: string, ttl: number, timeout: number): Promise<void> {
    const startedAt = Date.now();
    let acquiring = true;
    while (acquiring) {
      const result = await this.client.set(redisKey, token, { NX: true, PX: ttl });
      if (result === 'OK') {
        acquiring = false;
        continue;
      }
      if (timeout === 0 || Date.now() - startedAt >= timeout) {
        throw new LockAcquireError(`Lock acquire timed out for key ${redisKey}`);
      }
      await this.sleep(20);
    }
  }

  private async renew(redisKey: string, token: string, ttl: number): Promise<void> {
    const result = await this.client.sendCommand(['EVAL', RENEW_SCRIPT, '1', redisKey, token, String(ttl)]);
    if (Number(result) !== 1) throw new LockAbortError(`Lock ${redisKey} is no longer owned by this process`, {});
  }

  private createReleaser(redisKey: string, token: string): Releaser {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.client.sendCommand(['EVAL', RELEASE_SCRIPT, '1', redisKey, token]);
    };
  }

  private getKey(key: string): string {
    return `nocobase:${this.options.app.name}:lock:${key}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}
