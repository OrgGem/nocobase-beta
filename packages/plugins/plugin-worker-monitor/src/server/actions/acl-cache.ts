import { Context } from '@nocobase/actions';
import { scanKeys, deleteKeysChunked } from '../utils/redis';

/**
 * In-memory ACL stats counter.
 * Tracks total checks, cache hits/misses per role:resource:action.
 */
export interface AclCacheStats {
  totalChecks: number;
  cacheHits: number;
  cacheMisses: number;
  startedAt: string;
  detailByRole: Record<string, { checks: number; hits: number; misses: number }>;
}

const stats: AclCacheStats = {
  totalChecks: 0,
  cacheHits: 0,
  cacheMisses: 0,
  startedAt: new Date().toISOString(),
  detailByRole: {},
};

const ACL_CACHE_PREFIX = 'acl:can:';
const ACL_CACHE_TTL = 60 * 5; // 5 minutes default

function getCacheKey(role: string, resource: string, action: string): string {
  return `${ACL_CACHE_PREFIX}${role}:${resource}:${action}`;
}

function recordStat(role: string, hit: boolean) {
  stats.totalChecks++;
  if (hit) {
    stats.cacheHits++;
  } else {
    stats.cacheMisses++;
  }
  if (!stats.detailByRole[role]) {
    stats.detailByRole[role] = { checks: 0, hits: 0, misses: 0 };
  }
  stats.detailByRole[role].checks++;
  if (hit) {
    stats.detailByRole[role].hits++;
  } else {
    stats.detailByRole[role].misses++;
  }
}

/**
 * Middleware that wraps acl.can() with Redis caching.
 * Install via: app.resourcer.use(aclCacheMiddleware, { tag: 'aclCache', before: 'acl', after: 'setCurrentRole' })
 *
 * FIX: Previously monkey-patched ctx.app.acl.can per-request, which is a race condition
 * because acl is a shared singleton across concurrent requests. Now we use a post-check
 * approach that reads from cache first and writes after the ACL middleware runs, without
 * ever replacing the shared acl.can method.
 */
export function createAclCacheMiddleware(app: any) {
  return async function aclCacheMiddleware(ctx: Context, next: () => Promise<void>) {
    const cache = app.cache;
    if (!cache) {
      return next();
    }

    const role = ctx.state?.currentRole;
    const resourceName = ctx.action?.resourceName;
    const actionName = ctx.action?.actionName;

    if (!role || !resourceName || !actionName) {
      return next();
    }

    const cacheKey = getCacheKey(role, resourceName, actionName);

    // Try reading from cache first
    try {
      const cached = await cache.get(cacheKey);
      if (cached !== undefined && cached !== null) {
        recordStat(role, true);
        // Set permission from cache so acl middleware can skip heavy computation
        ctx.permission = ctx.permission || {};
        ctx.permission.can = cached === '__DENIED__' ? null : JSON.parse(cached);
        ctx.permission.skip = true;
        return next();
      }
    } catch {
      // Cache read failed, proceed normally
    }

    recordStat(role, false);

    // Let the ACL middleware run normally
    await next();

    // After ACL ran, cache the permission result for future requests
    // This is safe because we read ctx.permission AFTER next() completes —
    // no monkey-patching of shared singletons.
    try {
      const result = ctx.permission?.can;
      const valueToCache = result ? JSON.stringify(result) : '__DENIED__';
      cache.set(cacheKey, valueToCache, ACL_CACHE_TTL).catch(() => {});
    } catch {
      // Ignore cache write errors
    }
  };
}

export const aclCacheActions = {
  /**
   * GET /workerMonitorAclCache:stats
   * Returns ACL cache hit/miss statistics
   */
  async stats(ctx: Context, next: () => Promise<void>) {
    const hitRate =
      stats.totalChecks > 0 ? Math.round((stats.cacheHits / stats.totalChecks) * 10000) / 100 : 0;

    // Count cached keys using SCAN (production-safe)
    let cachedKeys = 0;
    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const keys = await scanKeys(redis, `*${ACL_CACHE_PREFIX}*`);
        cachedKeys = keys.length;
      }
    } catch {
      // Redis not available
    }

    ctx.body = {
      ...stats,
      hitRate,
      cachedKeys,
      ttlSeconds: ACL_CACHE_TTL,
    };
    await next();
  },

  /**
   * GET /workerMonitorAclCache:listKeys
   * Lists all cached ACL permission keys
   */
  async listKeys(ctx: Context, next: () => Promise<void>) {
    const keys: { key: string; role: string; resource: string; action: string }[] = [];

    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const rawKeys = await scanKeys(redis, `*${ACL_CACHE_PREFIX}*`);
        for (const key of rawKeys) {
          const parts = key.replace(ACL_CACHE_PREFIX, '').split(':');
          keys.push({
            key,
            role: parts[0] || '',
            resource: parts[1] || '',
            action: parts[2] || '',
          });
        }
      }
    } catch {
      // Redis not available
    }

    ctx.body = { data: keys, meta: { count: keys.length } };
    await next();
  },

  /**
   * POST /workerMonitorAclCache:clear
   * Clear all ACL cache entries and reset stats
   */
  async clear(ctx: Context, next: () => Promise<void>) {
    const user = ctx.state?.currentUser?.nickname || ctx.state?.currentUser?.id || 'unknown';
    ctx.app.logger.info(`[worker-monitor] Clearing all ACL cache by user ${user}`);
    let deletedCount = 0;

    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const rawKeys = await scanKeys(redis, `*${ACL_CACHE_PREFIX}*`);
        if (rawKeys.length > 0) {
          deletedCount = await deleteKeysChunked(redis, rawKeys);
        }
      }
    } catch {
      // Fallback: clear through app cache
      try {
        await ctx.app.cache.reset?.();
      } catch {
        // Ignore
      }
    }

    // Also clear role caches
    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const roleKeys = await scanKeys(redis, 'roles:*');
        if (roleKeys.length > 0) {
          deletedCount += await deleteKeysChunked(redis, roleKeys);
        }
        // Also clear system settings cache
        try {
          await redis.sendCommand(['DEL', 'app:systemSettings']);
          deletedCount++;
        } catch {
          // Ignore if clear fails
        }
      }
    } catch {
      // Redis not available
    }

    ctx.body = { success: true, deletedCount };
    await next();
  },

  /**
   * POST /workerMonitorAclCache:resetStats
   * Reset the in-memory ACL stats counters
   */
  async resetStats(ctx: Context, next: () => Promise<void>) {
    stats.totalChecks = 0;
    stats.cacheHits = 0;
    stats.cacheMisses = 0;
    stats.startedAt = new Date().toISOString();
    stats.detailByRole = {};

    ctx.body = { success: true };
    await next();
  },

  /**
   * POST /workerMonitorAclCache:clearRole
   * Clear ACL cache entries for a specific role
   */
  async clearRole(ctx: Context, next: () => Promise<void>) {
    const { roleName } = ctx.action.params.values || ctx.action.params;
    if (!roleName) {
      ctx.throw(400, 'roleName is required');
    }

    let deletedCount = 0;
    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const pattern = `*${ACL_CACHE_PREFIX}${roleName}:*`;
        const rawKeys = await scanKeys(redis, pattern);
        if (rawKeys.length > 0) {
          deletedCount = await deleteKeysChunked(redis, rawKeys);
        }
      }
    } catch {
      // Redis not available
    }

    ctx.body = { success: true, deletedCount };
    await next();
  },
};
