import { Context } from '@nocobase/actions';

function getRedis(ctx: Context) {
  return ctx.app.redisConnectionManager?.getConnection();
}

export const cacheMonitorActions = {
  /**
   * GET /workerMonitorCacheMgr:stores
   * List all registered cache stores and their config
   */
  async stores(ctx: Context, next: () => Promise<void>) {
    const cm = ctx.app.cacheManager;
    if (!cm) {
      ctx.throw(503, 'Cache manager is not available');
    }

    const stores: any[] = [];

    // storeTypes is a Map of registered store type configs
    const storeTypes = (cm as any).storeTypes as Map<string, any>;
    if (storeTypes) {
      for (const [name, config] of storeTypes.entries()) {
        const storeType = config.store === 'memory' ? 'memory' : 'redis';
        stores.push({
          name,
          type: storeType,
          isDefault: name === cm.defaultStore,
        });
      }
    }

    ctx.body = { data: stores, meta: { count: stores.length, defaultStore: cm.defaultStore } };
    await next();
  },

  /**
   * GET /workerMonitorCacheMgr:caches
   * List all created named caches
   */
  async caches(ctx: Context, next: () => Promise<void>) {
    const cm = ctx.app.cacheManager;
    if (!cm) {
      ctx.throw(503, 'Cache manager is not available');
    }

    const caches: any[] = [];
    const cacheMap = (cm as any).caches as Map<string, any>;
    if (cacheMap) {
      for (const [name, cache] of cacheMap.entries()) {
        caches.push({
          name,
          prefix: (cache as any).prefix || null,
        });
      }
    }

    ctx.body = { data: caches, meta: { count: caches.length } };
    await next();
  },

  /**
   * GET /workerMonitorCacheMgr:redisMemory
   * Get Redis memory usage for cache keys
   */
  async redisMemory(ctx: Context, next: () => Promise<void>) {
    const redis = getRedis(ctx);
    if (!redis) {
      ctx.body = { available: false };
      await next();
      return;
    }

    try {
      const info = await redis.sendCommand(['INFO', 'memory']);
      const lines = String(info).split(/\r?\n/);
      const memInfo: Record<string, string> = {};
      for (const line of lines) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          memInfo[line.slice(0, idx)] = line.slice(idx + 1).trim();
        }
      }

      // Count keys by prefix pattern
      const dbSize = await redis.sendCommand(['DBSIZE']);

      ctx.body = {
        available: true,
        usedMemory: memInfo.used_memory_human,
        usedMemoryBytes: Number(memInfo.used_memory || 0),
        totalKeys: Number(dbSize) || 0,
      };
    } catch (e: any) {
      ctx.body = { available: false, error: e.message };
    }
    await next();
  },

  /**
   * POST /workerMonitorCacheMgr:flushAll
   * Flush all caches via CacheManager
   */
  async flushAll(ctx: Context, next: () => Promise<void>) {
    const cm = ctx.app.cacheManager;
    if (!cm) {
      ctx.throw(503, 'Cache manager is not available');
    }

    const user = ctx.state?.currentUser?.nickname || ctx.state?.currentUser?.id || 'unknown';
    ctx.app.logger.warn(`[worker-monitor] Flushing all caches by user ${user}`);

    await cm.flushAll();

    ctx.body = { success: true };
    await next();
  },
};
