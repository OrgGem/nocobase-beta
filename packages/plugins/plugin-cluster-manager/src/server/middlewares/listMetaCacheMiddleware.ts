import { Context } from '@nocobase/actions';
import { cacheVersionManager } from '../utils/versionManager';

const LIST_META_CACHE_TTL = 1000 * 60 * 10; // 10 minutes cache duration

export function createListMetaCacheMiddleware(app: any) {
  return async function listMetaCacheMiddleware(ctx: Context, next: () => Promise<void>) {
    const cache = app.cache;
    // Skip caching if cache manager is not initialized or this is not collections:listMeta
    if (!cache || ctx.action?.resourceName !== 'collections' || ctx.action?.actionName !== 'listMeta') {
      return next();
    }

    const currentRole = ctx.state?.currentRole || 'anonymous';
    const appName = ctx.headers['x-app'] || 'main';
    const dataSource = ctx.headers['x-data-source'] || 'main';
    const locale = ctx.headers['x-locale'] || ctx.headers['accept-language'] || 'en-US';

    try {
      const version = await cacheVersionManager.getCollectionVersion(app);
      const cacheKey = `nb:cache:${appName}:meta:v${version}:ds:${dataSource}:role:${currentRole}:lang:${locale}`;

      // Try reading from NocoBase shared cache manager (Redis or Memory)
      const cached = await cache.get(cacheKey);
      if (cached !== undefined && cached !== null) {
        ctx.body = typeof cached === 'string' ? JSON.parse(cached) : cached;
        ctx.set?.('X-Cache', 'HIT');
        return;
      }

      await next();

      // If the response is valid, write to cache manager
      if (ctx.status === 200 && ctx.body) {
        const valueToCache = typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body);
        await cache.set(cacheKey, valueToCache, LIST_META_CACHE_TTL);
        ctx.set?.('X-Cache', 'MISS');
      }
    } catch (err: any) {
      // If any error occurs in cache layers, fallback gracefully to normal execution
      app.logger.error(`[ClusterManager] listMeta cache middleware fallback: ${err.message}`);
      await next();
    }
  };
}
