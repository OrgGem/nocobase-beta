import { Context } from '@nocobase/actions';
import { createClient } from 'redis';

let globalRedisClient: any = null;

export function getRedisClient(app?: any) {
  if (globalRedisClient) return globalRedisClient;

  if (app?.redisConnectionManager) {
    const conn = app.redisConnectionManager.getConnection();
    if (conn) return conn;
  }

  const url = process.env.REDIS_URL || process.env.CACHE_REDIS_URL || process.env.PUBSUB_ADAPTER_REDIS_URL;
  if (!url) return null;

  globalRedisClient = createClient({ url });
  globalRedisClient.connect().catch((err: any) => {
    console.error('[ClusterManager] Redis fallback connection error:', err);
  });
  return globalRedisClient;
}

/**
 * Get the shared Redis connection from the app's connection manager.
 * Returns undefined if Redis is not configured.
 */
export function getRedis(ctx: Context) {
  return getRedisClient(ctx.app);
}

/**
 * Get Redis connection or throw 503 if not available.
 */
export function getRedisOrThrow(ctx: Context) {
  const conn = ctx.app.redisConnectionManager?.getConnection();
  if (!conn) {
    ctx.throw(503, 'Redis is not configured or not connected');
  }
  return conn;
}

/**
 * Scan Redis keys using SCAN (cursor-based) instead of the blocking KEYS command.
 * Safe for production use — never blocks the Redis event loop.
 *
 * @param redis - Redis client instance
 * @param pattern - Glob pattern to match keys (e.g. "acl:can:*")
 * @param batchSize - Number of keys to scan per iteration (default 200)
 */
export async function scanKeys(redis: any, pattern: string, batchSize = 200): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';

  do {
    const result = await redis.sendCommand([
      'SCAN', cursor, 'MATCH', pattern, 'COUNT', String(batchSize),
    ]);

    // result is [nextCursor, [...keys]]
    cursor = String(result[0]);
    if (Array.isArray(result[1])) {
      keys.push(...result[1]);
    }
  } while (cursor !== '0');

  return keys;
}

/**
 * Delete keys in chunked batches to avoid exceeding Redis command argument limits.
 *
 * @param redis - Redis client instance
 * @param keys - Array of keys to delete
 * @param chunkSize - Max keys per DEL command (default 500)
 * @returns Total number of keys deleted
 */
export async function deleteKeysChunked(redis: any, keys: string[], chunkSize = 500): Promise<number> {
  let deleted = 0;

  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    if (chunk.length > 0) {
      try {
        const result = await redis.sendCommand(['DEL', ...chunk]);
        deleted += Number(result) || 0;
      } catch {
        // Continue with remaining chunks
      }
    }
  }

  return deleted;
}
