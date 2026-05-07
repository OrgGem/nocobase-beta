/**
 * Admin API actions for User Memory plugin management.
 *
 * Phase 5: All mutating actions now invalidate the MemoryInjector cache.
 * Phase 6: updateSettings validates all incoming fields and reschedules the
 *           cron job when syncSchedule changes.
 */

import { Context, Next } from '@nocobase/actions';
import { MemorySyncJob } from '../cron/memory-sync-job';
import { MemoryProfileService } from '../services/memory-profile.service';
import type { PluginUserMemoryServer } from '../plugin';

/** Resolve plugin singleton from context */
function getPlugin(ctx: Context): PluginUserMemoryServer | null {
  try {
    return ctx.app.pm.get('user-memory') as PluginUserMemoryServer;
  } catch {
    return null;
  }
}

// ─── Phase 6: Settings validation helpers ────────────────────────────────────────────

const CRON_REGEX = /^(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)\s+(\*|[0-9,\-*/]+)(\s+(\*|[0-9,\-*/]+))?$/;

function validateSettings(values: Record<string, any>): string | null {
  if ('enabled' in values && typeof values.enabled !== 'boolean') {
    return 'enabled must be a boolean';
  }
  if ('syncSchedule' in values) {
    if (typeof values.syncSchedule !== 'string' || !CRON_REGEX.test(values.syncSchedule.trim())) {
      return 'syncSchedule must be a valid cron expression (5 or 6 fields)';
    }
  }
  if ('maxTokens' in values) {
    const v = Number(values.maxTokens);
    if (!Number.isInteger(v) || v < 100 || v > 3000) {
      return 'maxTokens must be an integer between 100 and 3000';
    }
  }
  if ('maxConversationsPerSync' in values) {
    const v = Number(values.maxConversationsPerSync);
    if (!Number.isInteger(v) || v < 1 || v > 200) {
      return 'maxConversationsPerSync must be an integer between 1 and 200';
    }
  }
  if ('syncLogRetentionDays' in values) {
    const v = Number(values.syncLogRetentionDays);
    if (!Number.isInteger(v) || v < 1 || v > 365) {
      return 'syncLogRetentionDays must be an integer between 1 and 365';
    }
  }
  return null; // valid
}

/**
 * GET /api/userMemoryAdmin:getSettings — Get global settings
 */
export async function getSettings(ctx: Context, next: Next) {
  const settings = await ctx.db.getRepository('userMemorySettings').findOne();
  ctx.body = settings || {};
  await next();
}

/**
 * POST /api/userMemoryAdmin:updateSettings — Update global settings (admin only)
 *
 * Phase 6: Validates all incoming fields. Reschedules cron job when syncSchedule changes.
 */
export async function updateSettings(ctx: Context, next: Next) {
  const values = ctx.action.params.values || {};

  // Phase 6: Validate incoming settings before persisting
  const validationError = validateSettings(values);
  if (validationError) {
    ctx.status = 400;
    ctx.body = { error: validationError };
    return next();
  }

  const repo = ctx.db.getRepository('userMemorySettings');
  const existingSettings = await repo.findOne();

  if (existingSettings) {
    await repo.update({
      filter: { id: existingSettings.id },
      values,
    });
  } else {
    await repo.create({ values });
  }

  const updated = await repo.findOne();

  // Phase 6: If syncSchedule changed, reschedule the cron job immediately
  if ('syncSchedule' in values && values.syncSchedule !== existingSettings?.syncSchedule) {
    try {
      await getPlugin(ctx)?.rescheduleSyncJob(values.syncSchedule);
    } catch (err: any) {
      ctx.app.logger.warn('[UserMemory] Failed to reschedule cron job:', err.message);
      // Don't fail the settings update — just log
    }
  }

  ctx.body = updated;
  await next();
}

/**
 * POST /api/userMemoryAdmin:syncAll — Trigger sync for all users (admin only)
 */
export async function syncAll(ctx: Context, next: Next) {
  const syncJob = new MemorySyncJob(ctx.app);
  const result = await syncJob.syncAll();

  // Phase 5: Invalidate ALL cached profiles after admin-triggered full sync
  getPlugin(ctx)?.invalidateMemoryCache();

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

    // Phase 5: Invalidate cache for this user so next chat uses fresh memory
    getPlugin(ctx)?.invalidateMemoryCache(Number(userId));

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
