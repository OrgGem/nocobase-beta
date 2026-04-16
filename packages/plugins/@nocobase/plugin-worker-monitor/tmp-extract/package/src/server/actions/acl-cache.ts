import { Context } from '@nocobase/actions';

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

    // Store original acl.can to intercept result
    const originalCan = ctx.app?.acl?.can?.bind(ctx.app.acl);
    if (originalCan && ctx.app.acl) {
      const origMethod = ctx.app.acl.can;
      ctx.app.acl.can = function (params: any) {
        const result = origMethod.call(this, params);
        // Cache the result asynchronously
        try {
          const valueToCache = result ? JSON.stringify(result) : '__DENIED__';
          cache.set(cacheKey, valueToCache, ACL_CACHE_TTL).catch(() => {});
        } catch {
          // Ignore cache write errors
        }
        return result;
      };

      await next();

      // Restore original method
      ctx.app.acl.can = origMethod;
    } else {
      await next();
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

    // Count cached keys in Redis
    let cachedKeys = 0;
    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const keys = await redis.sendCommand(['KEYS', `${ACL_CACHE_PREFIX}*`]);
        cachedKeys = Array.isArray(keys) ? keys.length : 0;
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
    const cache = ctx.app.cache;
    const keys: { key: string; role: string; resource: string; action: string }[] = [];

    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const rawKeys = (await redis.sendCommand(['KEYS', `${ACL_CACHE_PREFIX}*`])) as string[];
        for (const key of rawKeys || []) {
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
    let deletedCount = 0;

    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const rawKeys = (await redis.sendCommand(['KEYS', `${ACL_CACHE_PREFIX}*`])) as string[];
        if (rawKeys && rawKeys.length > 0) {
          deletedCount = rawKeys.length;
          await redis.sendCommand(['DEL', ...rawKeys]);
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
        const roleKeys = (await redis.sendCommand(['KEYS', 'roles:*'])) as string[];
        if (roleKeys && roleKeys.length > 0) {
          deletedCount += roleKeys.length;
          await redis.sendCommand(['DEL', ...roleKeys]);
        }
        // Also clear system settings cache
        try {
          await redis.sendCommand(['DEL', 'app:systemSettings']);
          deletedCount++;
        } catch {}
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
        const pattern = `${ACL_CACHE_PREFIX}${roleName}:*`;
        const rawKeys = (await redis.sendCommand(['KEYS', pattern])) as string[];
        if (rawKeys && rawKeys.length > 0) {
          deletedCount = rawKeys.length;
          await redis.sendCommand(['DEL', ...rawKeys]);
        }
      }
    } catch {
      // Redis not available
    }

    ctx.body = { success: true, deletedCount };
    await next();
  },
};
