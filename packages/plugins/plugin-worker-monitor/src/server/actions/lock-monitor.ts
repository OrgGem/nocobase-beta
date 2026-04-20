import { Context } from '@nocobase/actions';

function getRedis(ctx: Context) {
  return ctx.app.redisConnectionManager?.getConnection();
}

export const lockActions = {
  /**
   * GET /workerMonitorLock:info
   * Returns lock manager info
   */
  async info(ctx: Context, next: () => Promise<void>) {
    const lm = ctx.app.lockManager;
    if (!lm) {
      ctx.throw(503, 'Lock manager is not available');
    }

    const options = (lm as any).options || {};
    const adapterType = options.defaultAdapter || 'local';

    let activeLocks = 0;

    if (adapterType === 'local') {
      // LocalLockAdapter uses static Map
      try {
        // LocalLockAdapter uses a static Map; access it via the adapter instance
        const adapter = (lm as any).adapters?.get?.('local');
        const lockMap = adapter?.constructor?.locks;
        if (lockMap instanceof Map) {
          for (const mutex of lockMap.values()) {
            if (mutex.isLocked?.()) activeLocks++;
          }
        }
      } catch {
        // Ignore
      }
    } else {
      // For Redis adapter, scan for lock keys
      try {
        const redis = getRedis(ctx);
        if (redis) {
          const keys = (await redis.sendCommand(['KEYS', 'lock:*'])) as string[];
          activeLocks = keys?.length || 0;
        }
      } catch {
        // Ignore
      }
    }

    ctx.body = {
      adapter: adapterType,
      activeLocks,
    };
    await next();
  },

  /**
   * GET /workerMonitorLock:list
   * List active locks
   */
  async list(ctx: Context, next: () => Promise<void>) {
    const lm = ctx.app.lockManager;
    if (!lm) {
      ctx.throw(503, 'Lock manager is not available');
    }

    const options = (lm as any).options || {};
    const adapterType = options.defaultAdapter || 'local';
    const locks: any[] = [];

    if (adapterType === 'local') {
      try {
        const adapter = (lm as any).adapters?.get?.('local');
        const lockMap = adapter?.constructor?.locks;
        if (lockMap instanceof Map) {
          for (const [key, mutex] of lockMap.entries()) {
            if (mutex.isLocked?.()) {
              locks.push({ key, locked: true, ttl: null, adapter: 'local' });
            }
          }
        }
      } catch {
        // Ignore
      }
    } else {
      // Redis adapter: scan lock keys and get TTL
      try {
        const redis = getRedis(ctx);
        if (redis) {
          const keys = (await redis.sendCommand(['KEYS', 'lock:*'])) as string[];
          for (const key of keys || []) {
            const ttl = (await redis.sendCommand(['PTTL', key])) as number;
            locks.push({ key, locked: true, ttl: ttl > 0 ? ttl : null, adapter: 'redis' });
          }
        }
      } catch {
        // Ignore
      }
    }

    ctx.body = { data: locks, meta: { count: locks.length } };
    await next();
  },

  /**
   * POST /workerMonitorLock:release
   * Force release a stuck lock (admin emergency action)
   */
  async release(ctx: Context, next: () => Promise<void>) {
    const { key } = ctx.action.params.values || ctx.action.params;
    if (!key) {
      ctx.throw(400, 'Lock key is required');
    }

    const lm = ctx.app.lockManager;
    const options = (lm as any).options || {};
    const adapterType = options.defaultAdapter || 'local';
    let released = false;

    const user = ctx.state?.currentUser?.nickname || ctx.state?.currentUser?.id || 'unknown';
    ctx.app.logger.warn(`[worker-monitor] Force releasing lock "${key}" by user ${user}`);

    if (adapterType === 'local') {
      try {
        const adapter = (lm as any).adapters?.get?.('local');
        const lockMap = adapter?.constructor?.locks;
        if (lockMap instanceof Map && lockMap.has(key)) {
          const mutex = lockMap.get(key);
          if (mutex.isLocked?.()) {
            mutex.release?.();
          }
          lockMap.delete(key);
          released = true;
        }
      } catch {
        // Ignore
      }
    } else {
      try {
        const redis = getRedis(ctx);
        if (redis) {
          const result = await redis.sendCommand(['DEL', key]);
          released = Number(result) > 0;
        }
      } catch {
        // Ignore
      }
    }

    ctx.body = { success: released };
    await next();
  },
};
