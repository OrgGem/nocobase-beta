import { ILockAdapter, ILock, Releaser, LockAcquireError, LockAbortError } from '@nocobase/lock-manager';
import { v4 as uuidv4 } from 'uuid';
import { Application } from '@nocobase/server';
import { createClient } from 'redis';

export class RedisLockAdapter implements ILockAdapter {
  private client: ReturnType<typeof createClient>;
  
  constructor(private options: { url?: string, app: Application }) {
    if (this.options.url) {
      this.client = createClient({ url: this.options.url });
    } else {
      this.client = (this.options.app as any).redisConnectionManager?.getConnection();
    }

    if (!this.client) {
      throw new Error('[RedisLockAdapter] Redis client not found or unavailable');
    }
  }

  async connect() {
    if (this.options.url && !this.client.isOpen) {
      await this.client.connect();
    }
  }

  async close() {
    if (this.options.url && this.client.isOpen) {
      await this.client.quit();
    }
  }

  async acquire(key: string, ttl: number): Promise<Releaser> {
    const lockId = uuidv4();
    const realKey = `nocobase:lock:${key}`;
    const startTime = Date.now();
    const maxWaitMs = Math.min(ttl, 30000); // Wait at most 30s or the TTL, whichever is smaller
    
    // Spin-lock pattern: Loop until lock is acquired or wall-clock timeout
    while (true) {
      try {
        const result = await this.client.set(realKey, lockId, { NX: true, PX: ttl });
        if (result === 'OK') break;
      } catch (e) {
        // Ignore redis command throw
      }

      if (Date.now() - startTime > maxWaitMs) {
        throw new LockAcquireError(`Lock acquire timed out after ${maxWaitMs}ms for key ${key}`);
      }
      await new Promise(r => setTimeout(r, 50));
    }
    
    // Create idempotency guard for releasing
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const script = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
      try {
        await this.client.eval(script, { keys: [realKey], arguments: [lockId] });
      } catch (e) {
        // Safe to ignore eval failure on release
      }
    };
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>, ttl: number): Promise<T> {
    const release = await this.acquire(key, ttl);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  async tryAcquire(key: string, timeout = 0): Promise<ILock> {
    const lockId = uuidv4();
    const realKey = `nocobase:lock:${key}`;
    const start = Date.now();
    let acquired = false;
    
    while (!acquired) {
      try {
        // Initial lease if acquired is 10 seconds.
        const result = await this.client.set(realKey, lockId, { NX: true, PX: 10000 });
        if (result === 'OK') {
          acquired = true;
          break;
        }
      } catch (e) {}

      if (timeout === 0 || Date.now() - start >= timeout) {
        throw new LockAcquireError('lock acquire timed out or locked');
      }
      await new Promise(r => setTimeout(r, 20));
    }
    
    // Return an instantiated ILock interface allowing NocoBase LockManager to consume or release
    let explicitRelease = false;
    
    const releaseFn = async () => {
      if (explicitRelease) return;
      explicitRelease = true;
      const script = `if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
      try { await this.client.eval(script, { keys: [realKey], arguments: [lockId] }); } catch (e) {}
    };

    return {
      release: releaseFn,
      acquire: async (ttl: number) => {
         await this.client.pExpire(realKey, ttl);
         return releaseFn;
      },
      runExclusive: async <T>(fn: () => Promise<T>, ttl: number) => {
         await this.client.pExpire(realKey, ttl);
         try { return await fn(); } finally { await releaseFn(); }
      }
    };
  }
}
