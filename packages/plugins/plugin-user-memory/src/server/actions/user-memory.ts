/**
 * User Memory API actions — Resource handlers for the userMemory resource.
 *
 * Phase 5 change: All mutating actions now invalidate the MemoryInjector cache
 * via the plugin singleton so that the next chat request uses fresh data
 * immediately (instead of waiting up to 5 min for TTL expiry).
 */

import { Context, Next } from '@nocobase/actions';
import { MemoryProfileService } from '../services/memory-profile.service';
import { MemorySyncJob } from '../cron/memory-sync-job';
import type { PluginUserMemoryServer } from '../plugin';

/** Resolve plugin singleton from context for cache invalidation */
function getPlugin(ctx: Context): PluginUserMemoryServer | null {
  try {
    return ctx.app.pm.get('user-memory') as PluginUserMemoryServer;
  } catch {
    return null;
  }
}

/**
 * GET /api/userMemory:getProfile — Get current user's memory profile
 */
export async function getProfile(ctx: Context, next: Next) {
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    return ctx.throw(403);
  }

  const service = new MemoryProfileService(ctx.db);
  const profile = await service.getOrCreate(userId);

  ctx.body = {
    memoryContent: profile.memoryContent || '',
    memoryVersion: profile.memoryVersion,
    lastSyncedAt: profile.lastSyncedAt,
    status: profile.status,
    enabled: profile.enabled,
    metadata: profile.metadata,
  };

  await next();
}

/**
 * POST /api/userMemory:toggleEnabled — Enable/disable memory for current user
 */
export async function toggleEnabled(ctx: Context, next: Next) {
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    return ctx.throw(403);
  }

  const { enabled } = ctx.action.params.values || {};
  if (typeof enabled !== 'boolean') {
    return ctx.throw(400, 'enabled must be a boolean');
  }

  const service = new MemoryProfileService(ctx.db);
  await service.toggleEnabled(userId, enabled);

  // Phase 5: Invalidate cache so next chat reflects the toggle immediately
  getPlugin(ctx)?.invalidateMemoryCache(userId);

  ctx.body = { success: true, enabled };
  await next();
}

/**
 * POST /api/userMemory:syncNow — Manually trigger memory sync for current user
 */
export async function syncNow(ctx: Context, next: Next) {
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    return ctx.throw(403);
  }

  // Rate limiting: prevent excessive sync triggers (5 min cooldown)
  const service = new MemoryProfileService(ctx.db);
  const remainingMs = await service.getRateLimitRemainingMs(userId);
  if (remainingMs > 0) {
    const remainingSec = Math.ceil(remainingMs / 1000);
    ctx.body = {
      result: 'rate_limited',
      message: `Please wait ${remainingSec} seconds before syncing again`,
      retryAfterMs: remainingMs,
    };
    return next();
  }

  const syncJob = new MemorySyncJob(ctx.app);
  try {
    const result = await syncJob.syncUser(userId, 'manual');

    // Phase 5: Invalidate cache after sync so next chat uses fresh memory
    getPlugin(ctx)?.invalidateMemoryCache(userId);

    const profile = await service.getOrCreate(userId);

    ctx.body = {
      result,
      memoryContent: profile.memoryContent,
      memoryVersion: profile.memoryVersion,
      lastSyncedAt: profile.lastSyncedAt,
    };
  } catch (error: any) {
    ctx.status = 500;
    ctx.body = {
      result: 'error',
      error: error.message,
    };
  }

  await next();
}

/**
 * GET /api/userMemory:getSyncLogs — Get sync history for current user
 */
export async function getSyncLogs(ctx: Context, next: Next) {
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    return ctx.throw(403);
  }

  const { page = 1, pageSize = 20 } = ctx.action.params || {};

  const repo = ctx.db.getRepository('userMemorySyncLogs');
  const [rows, count] = await repo.findAndCount({
    filter: { 'user.id': userId },
    sort: ['-createdAt'],
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  ctx.body = {
    rows,
    count,
    page: Number(page),
    pageSize: Number(pageSize),
    totalPages: Math.ceil(count / pageSize),
  };

  await next();
}

/**
 * POST /api/userMemory:clearMemory — Clear the user's memory profile
 */
export async function clearMemory(ctx: Context, next: Next) {
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    return ctx.throw(403);
  }

  const service = new MemoryProfileService(ctx.db);
  await service.updateMemory(userId, '', null);

  // Phase 5: Invalidate cache so next chat reflects cleared memory immediately
  getPlugin(ctx)?.invalidateMemoryCache(userId);

  ctx.body = { success: true };
  await next();
}
