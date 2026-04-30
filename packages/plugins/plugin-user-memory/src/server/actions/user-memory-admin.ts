/**
 * Admin API actions for User Memory plugin management.
 */

import { Context, Next } from '@nocobase/actions';
import { MemorySyncJob } from '../cron/memory-sync-job';
import { MemoryProfileService } from '../services/memory-profile.service';

/**
 * GET /api/userMemoryAdmin:getSettings — Get global settings
 */
export async function getSettings(ctx: Context, next: Next) {
  const settings = await ctx.db.getRepository('userMemorySettings').findOne();
  ctx.body = settings || {};
  await next();
}

/**
 * POST /api/userMemoryAdmin:updateSettings — Update global settings
 */
export async function updateSettings(ctx: Context, next: Next) {
  const values = ctx.action.params.values || {};
  const repo = ctx.db.getRepository('userMemorySettings');

  let settings = await repo.findOne();
  if (settings) {
    await repo.update({
      filter: { id: settings.id },
      values,
    });
  } else {
    await repo.create({ values });
  }

  ctx.body = await repo.findOne();
  await next();
}

/**
 * POST /api/userMemoryAdmin:syncAll — Trigger sync for all users (admin only)
 */
export async function syncAll(ctx: Context, next: Next) {
  const syncJob = new MemorySyncJob(ctx.app);
  const result = await syncJob.syncAll();

  ctx.body = result;
  await next();
}

/**
 * GET /api/userMemoryAdmin:listProfiles — List all user memory profiles (admin)
 */
export async function listProfiles(ctx: Context, next: Next) {
  const { page = 1, pageSize = 20 } = ctx.action.params || {};

  const repo = ctx.db.getRepository('userMemoryProfiles');
  const [rows, count] = await repo.findAndCount({
    sort: ['-updatedAt'],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    appends: ['user'],
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
 * GET /api/userMemoryAdmin:getUserProfile — Get a specific user's profile (admin)
 */
export async function getUserProfile(ctx: Context, next: Next) {
  const { userId } = ctx.action.params || {};
  if (!userId) {
    return ctx.throw(400, 'userId is required');
  }

  const service = new MemoryProfileService(ctx.db);
  const profile = await service.getOrCreate(Number(userId));

  ctx.body = profile;
  await next();
}

/**
 * POST /api/userMemoryAdmin:syncUser — Trigger sync for a specific user (admin)
 */
export async function syncUser(ctx: Context, next: Next) {
  const { userId } = ctx.action.params.values || {};
  if (!userId) {
    return ctx.throw(400, 'userId is required');
  }

  const syncJob = new MemorySyncJob(ctx.app);
  try {
    const result = await syncJob.syncUser(Number(userId), 'manual');
    const service = new MemoryProfileService(ctx.db);
    const profile = await service.getOrCreate(Number(userId));

    ctx.body = { result, profile };
  } catch (error: any) {
    ctx.body = { result: 'error', error: error.message };
  }

  await next();
}

/**
 * POST /api/userMemoryAdmin:cleanupLogs — Clean up old sync logs
 */
export async function cleanupLogs(ctx: Context, next: Next) {
  const syncJob = new MemorySyncJob(ctx.app);
  const deleted = await syncJob.cleanupOldLogs();

  ctx.body = { deleted };
  await next();
}
