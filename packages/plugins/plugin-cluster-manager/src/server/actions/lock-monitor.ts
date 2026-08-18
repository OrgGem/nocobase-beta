import { Context } from '@nocobase/actions';
import { scanKeys } from '../utils/redis';

// Must match getKey() in RedisLockAdapter: nocobase:<appName>:lock:<name>
function getLockPrefix(app: any): string {
  return `nocobase:${app.name || 'main'}:lock:`;
}

// Prefix used by older builds of the adapter; kept so existing keys stay visible.
const LEGACY_LOCK_PREFIX = 'nocobase:lock:';

// Synthetic key prefix for agent-loop path locks (stored in the agentLoopPathLocks collection,
// not in the lock manager). Recognized so release() refuses them instead of DEL-ing Redis keys.
const PATH_LOCK_KEY_PREFIX = 'agent-loop:path:';

function getRedis(ctx: Context) {
  return ctx.app.redisConnectionManager?.getConnection();
}

/**
 * Agent-loop path locks live in the database (agentLoopPathLocks) and their lifecycle is owned
 * by the loop state machine, so they are surfaced read-only for visibility only.
 */
async function getPathLocks(ctx: Context): Promise<any[]> {
  try {
    const db = ctx.app.db;
    if (db.hasCollection && !db.hasCollection('agentLoopPathLocks')) return [];
    const rows = await db.getRepository('agentLoopPathLocks').find({
      filter: { status: 'held' },
      sort: ['-acquiredAt'],
    });
    const now = Date.now();
    return rows.map((row: any) => {
      const runId = row.get('runId');
      const repositoryKey = String(row.get('repositoryKey') || '');
      const expiresAt = row.get('expiresAt');
      const ttl = expiresAt ? Math.max(0, new Date(expiresAt).getTime() - now) : null;
      return {
        key: `${PATH_LOCK_KEY_PREFIX}${repositoryKey}:run:${runId}`,
        displayKey: `${repositoryKey} (run ${runId})`,
        locked: true,
        ttl,
        adapter: 'path-lock',
        readOnly: true,
      };
    });
  } catch {
    return [];
  }
}

export const lockActions = {
  /**
   * GET /clusterManagerLock:info
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
      // For Redis adapter, scan for lock keys (using correct prefix)
      try {
        const redis = getRedis(ctx);
        if (redis) {
          const keys = await scanKeys(redis, `${getLockPrefix(ctx.app)}*`);
          const legacyKeys = await scanKeys(redis, `${LEGACY_LOCK_PREFIX}*`);
          activeLocks = keys.length + legacyKeys.length;
        }
      } catch {
        // Ignore
      }
    }

    ctx.body = {
      adapter: adapterType,
      activeLocks,
      pathLocks: (await getPathLocks(ctx)).length,
    };
    await next();
  },

  /**
   * GET /clusterManagerLock:list
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
      // Redis adapter: scan lock keys using correct prefix and get TTL
      try {
        const redis = getRedis(ctx);
        if (redis) {
          const lockPrefix = getLockPrefix(ctx.app);
          const keys = await scanKeys(redis, `${lockPrefix}*`);
          const legacyKeys = await scanKeys(redis, `${LEGACY_LOCK_PREFIX}*`);
          for (const key of [...keys, ...legacyKeys]) {
            const ttl = (await redis.sendCommand(['PTTL', key])) as number;
            const displayKey = key.startsWith(lockPrefix)
              ? key.slice(lockPrefix.length)
              : key.slice(LEGACY_LOCK_PREFIX.length);
            locks.push({
              key,
              displayKey,
              locked: true,
              ttl: ttl > 0 ? ttl : null,
              adapter: 'redis',
            });
          }
        }
      } catch {
        // Ignore
      }
    }

    const pathLocks = await getPathLocks(ctx);
    ctx.body = { data: [...locks, ...pathLocks], meta: { count: locks.length + pathLocks.length } };
    await next();
  },

  /**
   * POST /clusterManagerLock:release
   * Force release a stuck lock (admin emergency action)
   * Uses compare-and-swap via DEL for Redis locks with the correct key prefix.
   */
  async release(ctx: Context, next: () => Promise<void>) {
    const { key } = ctx.action.params.values || ctx.action.params;
    if (!key) {
      ctx.throw(400, 'Lock key is required');
    }
    if (String(key).startsWith(PATH_LOCK_KEY_PREFIX)) {
      ctx.throw(400, 'Agent loop path locks are managed by the loop state machine and cannot be released here');
    }

    const lm = ctx.app.lockManager;
    const options = (lm as any).options || {};
    const adapterType = options.defaultAdapter || 'local';
    let released = false;

    const user = ctx.state?.currentUser?.nickname || ctx.state?.currentUser?.id || 'unknown';
    ctx.app.logger.warn(`[cluster-manager] Force releasing lock "${key}" by user ${user}`);

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
          // The key from the UI may be the full Redis key or just the lock name.
          // Normalize it into the lock namespace so DEL never targets other keys.
          const lockPrefix = getLockPrefix(ctx.app);
          const lockKey =
            key.startsWith(lockPrefix) || key.startsWith(LEGACY_LOCK_PREFIX) ? key : `${lockPrefix}${key}`;
          const result = await redis.sendCommand(['DEL', lockKey]);
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
