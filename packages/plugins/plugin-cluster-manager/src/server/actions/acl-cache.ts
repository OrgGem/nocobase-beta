import { Context } from '@nocobase/actions';
import { scanKeys, deleteKeysChunked } from '../utils/redis';
import { cacheVersionManager } from '../utils/versionManager';

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

function getCacheKey(options: {
  appName: string;
  dataSource: string;
  globalVersion: number;
  roleVersion: number;
  role: string;
  userId: string;
  resource: string;
  action: string;
}): string {
  const { appName, dataSource, globalVersion, roleVersion, role, userId, resource, action } = options;
  return `${ACL_CACHE_PREFIX}${appName}:${dataSource}:g${globalVersion}:r${roleVersion}:${role}:u${userId}:${resource}:${action}`;
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
 * Middleware that caches the permission object computed by the ACL middleware.
 * Install via: app.acl.use(aclCacheMiddleware, { tag: 'aclCache', before: 'core', after: 'allow-manager' })
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
    const resourceName = ctx.permission?.resourceName || ctx.action?.resourceName;
    const actionName = ctx.permission?.actionName || ctx.action?.actionName;

    if (!role || !resourceName || !actionName) {
      return next();
    }

    const appName = String(ctx.get?.('x-app') || ctx.headers?.['x-app'] || app.name || 'main');
    const dataSource = String(ctx.get?.('x-data-source') || ctx.headers?.['x-data-source'] || 'main');
    const userId = String(ctx.state?.currentUser?.id || 'anonymous');
    let cacheKey: string;

    try {
      const [globalVersion, roleVersion] = await Promise.all([
        cacheVersionManager.getGlobalAclVersion(app),
        cacheVersionManager.getAclVersion(app, role),
      ]);
      cacheKey = getCacheKey({
        appName,
        dataSource,
        globalVersion,
        roleVersion,
        role,
        userId,
        resource: resourceName,
        action: actionName,
      });
    } catch {
      return next();
    }

    // Try reading from cache first. Only the cache read/parse is guarded —
    // the downstream next() must stay outside the try so its errors propagate.
    // (A swallowed rejection there would fall through and invoke next() twice,
    // which koa-compose rejects with "next() called multiple times".)
    let cached: unknown;
    try {
      cached = await cache.get(cacheKey);
    } catch {
      // Cache read failed, proceed normally
    }

    if (cached !== undefined && cached !== null) {
      if (cached === '__DENIED__') {
        recordStat(role, true);
        ctx.throw(403, 'No permissions');
        return;
      }

      let cachedPermission: unknown;
      try {
        cachedPermission = typeof cached === 'string' ? JSON.parse(cached) : cached;
      } catch {
        // Corrupt cache entry — treat as a miss
      }

      if (cachedPermission !== undefined) {
        recordStat(role, true);
        // Replace the permission object computed for this request with the cached value.
        ctx.permission = ctx.permission || {};
        ctx.permission.can = cachedPermission;
        return next();
      }
    }

    recordStat(role, false);

    // Let the rest of the ACL middleware run normally. Cache denials issued by
    // the ACL core only — never turn a cached denial into a skipped permission
    // check, and never cache action-level 403s.
    try {
      await next();
    } catch (error: any) {
      if (error?.status === 403 || error?.statusCode === 403) {
        // The core ACL middleware throws 403 before the action runs, and only
        // when permission.can is falsy. Once the core has passed, can is an
        // object, so any later 403 comes from business logic inside the action
        // (e.g. "system-managed variable") and must not poison this cache —
        // otherwise legitimate calls to the same action would be rejected
        // until the TTL expires.
        const can = ctx.permission?.can;
        const coreDenied = !ctx.permission?.skip && (!can || typeof can !== 'object');
        if (coreDenied) {
          cache.set(cacheKey, '__DENIED__', ACL_CACHE_TTL).catch(() => {});
        }
      }
      throw error;
    }

    // After ACL ran, cache the permission result for future requests
    // This is safe because we read ctx.permission AFTER next() completes —
    // no monkey-patching of shared singletons.
    try {
      const result = ctx.permission?.can as any;
      const valueToCache = JSON.stringify(result !== undefined && result !== null ? result : true);
      cache.set(cacheKey, valueToCache, ACL_CACHE_TTL).catch(() => {});
    } catch {
      // Ignore cache write errors
    }
  };
}

export const aclCacheActions = {
  /**
   * GET /clusterManagerAclCache:stats
   * Returns ACL cache hit/miss statistics
   */
  async stats(ctx: Context, next: () => Promise<void>) {
    const hitRate = stats.totalChecks > 0 ? Math.round((stats.cacheHits / stats.totalChecks) * 10000) / 100 : 0;

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
      _note: 'Stats are per-node. In HA clusters each node tracks its own counters independently.',
    };
    await next();
  },

  /**
   * GET /clusterManagerAclCache:listKeys
   * Lists all cached ACL permission keys
   */
  async listKeys(ctx: Context, next: () => Promise<void>) {
    const keys: { key: string; role: string; resource: string; action: string }[] = [];

    try {
      const redis = (ctx.app as any).redisConnectionManager?.getConnection();
      if (redis) {
        const rawKeys = await scanKeys(redis, `*${ACL_CACHE_PREFIX}*`);
        for (const key of rawKeys) {
          // Key layout after the prefix: app:dataSource:g<v>:r<v>:role:u<id>:resource:action
          const parts = key.replace(ACL_CACHE_PREFIX, '').split(':');
          keys.push({
            key,
            role: parts[4] || '',
            resource: parts[6] || '',
            action: parts.slice(7).join(':'),
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
   * POST /clusterManagerAclCache:clear
   * Clear all ACL cache entries and reset stats
   */
  async clear(ctx: Context, next: () => Promise<void>) {
    const user = ctx.state?.currentUser?.nickname || ctx.state?.currentUser?.id || 'unknown';
    ctx.app.logger.info(`[cluster-manager] Clearing all ACL cache by user ${user}`);
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
   * POST /clusterManagerAclCache:resetStats
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
   * POST /clusterManagerAclCache:clearRole
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
        // The role is the 5th segment after the prefix (app:dataSource:g<v>:r<v>:role:...),
        // so scan the whole namespace and filter by segment instead of pattern.
        const rawKeys = await scanKeys(redis, `*${ACL_CACHE_PREFIX}*`);
        const roleKeys = rawKeys.filter((key) => key.replace(ACL_CACHE_PREFIX, '').split(':')[4] === roleName);
        if (roleKeys.length > 0) {
          deletedCount = await deleteKeysChunked(redis, roleKeys);
        }
      }
    } catch {
      // Redis not available
    }

    ctx.body = { success: true, deletedCount };
    await next();
  },
};
