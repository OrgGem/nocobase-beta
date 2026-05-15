/**
 * Admin Actions for Agent Session Context
 *
 * Provides REST API endpoints for administrators to:
 * - List/search context entries across all scopes
 * - View entries for a specific workflow run or session
 * - Delete individual entries or clear entire scopes
 * - Get aggregated statistics (entry counts, scope counts, storage usage)
 * - Force-prune expired entries on demand
 *
 * These actions are protected by the KB admin ACL snippet.
 */

import type { Context, Next } from '@nocobase/actions';
import PluginKnowledgeBaseServer from '../plugin';

/**
 * GET /api/agentSessionContext:stats
 *
 * Returns aggregated statistics about the session context store.
 * Useful for admin dashboards and monitoring.
 */
export async function stats(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository('agentSessionContext');

  // Fix P0-3: Exclude the large 'value' field to prevent OOM on large tables.
  // Fetch lightweight metadata only; compute storage estimate via LENGTH() if DB supports it.
  const allEntries = await repo.find({
    fields: ['id', 'rootRunId', 'sessionId', 'pipelineJobId', 'source', 'updatedAt', 'createdAt', 'ttlSeconds'],
  });

  const entries = allEntries as any[];
  const now = Date.now();

  // Compute stats without loading value content
  const uniqueRootRunIds = new Set<string>();
  const uniqueSessionIds = new Set<string>();
  const uniqueSources = new Set<string>();
  let expiredCount = 0;
  let activeCount = 0;

  for (const entry of entries) {
    if (entry.rootRunId) uniqueRootRunIds.add(entry.rootRunId);
    if (entry.sessionId) uniqueSessionIds.add(entry.sessionId);
    if (entry.source) uniqueSources.add(entry.source);

    // Expired check
    if (entry.ttlSeconds) {
      const updatedAt = entry.updatedAt
        ? new Date(entry.updatedAt).getTime()
        : entry.createdAt
          ? new Date(entry.createdAt).getTime()
          : 0;
      if (updatedAt && (now - updatedAt) / 1000 > entry.ttlSeconds) {
        expiredCount++;
      } else {
        activeCount++;
      }
    } else {
      activeCount++; // No TTL = permanent
    }
  }

  // Estimate storage via SQL SUM(LENGTH(value)) to avoid loading all values into memory
  let estimatedStorageKB = 0;
  try {
    const tableName = repo.collection.model.tableName;
    const [sizeResult] = await ctx.db.sequelize.query(
      `SELECT COALESCE(SUM(LENGTH("value")), 0) AS total_bytes FROM "${tableName}"`,
      { type: (ctx.db.sequelize.constructor as any).QueryTypes.SELECT },
    );
    estimatedStorageKB = Math.round(Number((sizeResult as any)?.total_bytes || 0) / 1024);
  } catch {
    // Fallback: storage estimate unavailable
    estimatedStorageKB = -1;
  }

  ctx.body = {
    totalEntries: entries.length,
    activeEntries: activeCount,
    expiredEntries: expiredCount,
    uniqueWorkflowRuns: uniqueRootRunIds.size,
    uniqueSessions: uniqueSessionIds.size,
    uniqueSources: Array.from(uniqueSources),
    estimatedStorageKB,
  };

  await next();
}

/**
 * GET /api/agentSessionContext:listScopes
 *
 * Returns a list of all active scopes (rootRunId / sessionId) with entry counts.
 * Allows admin to see which workflows have active context.
 */
export async function listScopes(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository('agentSessionContext');

  const entries = (await repo.find({
    fields: ['rootRunId', 'sessionId', 'key', 'source', 'updatedAt', 'createdAt', 'ttlSeconds'],
  })) as any[];

  const now = Date.now();
  const scopeMap = new Map<string, { type: string; id: string; entryCount: number; sources: Set<string>; lastUpdated: string }>();

  for (const entry of entries) {
    // Skip expired
    if (entry.ttlSeconds) {
      const updatedAt = entry.updatedAt
        ? new Date(entry.updatedAt).getTime()
        : entry.createdAt
          ? new Date(entry.createdAt).getTime()
          : 0;
      if (updatedAt && (now - updatedAt) / 1000 > entry.ttlSeconds) continue;
    }

    const scopeKey = entry.rootRunId
      ? `run:${entry.rootRunId}`
      : entry.sessionId
        ? `session:${entry.sessionId}`
        : 'unknown';
    const scopeType = entry.rootRunId ? 'rootRunId' : 'sessionId';
    const scopeId = entry.rootRunId || entry.sessionId || '';

    if (!scopeMap.has(scopeKey)) {
      scopeMap.set(scopeKey, {
        type: scopeType,
        id: scopeId,
        entryCount: 0,
        sources: new Set(),
        lastUpdated: '',
      });
    }

    const scope = scopeMap.get(scopeKey)!;
    scope.entryCount++;
    if (entry.source) scope.sources.add(entry.source);
    const entryDate = entry.updatedAt?.toISOString?.() || entry.createdAt?.toISOString?.() || '';
    if (entryDate > scope.lastUpdated) scope.lastUpdated = entryDate;
  }

  ctx.body = Array.from(scopeMap.values())
    .map((s) => ({ ...s, sources: Array.from(s.sources) }))
    .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated));

  await next();
}

/**
 * GET /api/agentSessionContext:listEntries?rootRunId=xxx OR sessionId=xxx
 *
 * List all context entries for a specific scope.
 * Admin can inspect what agents have written.
 */
export async function listEntries(ctx: Context, next: Next) {
  const { rootRunId, sessionId, pipelineJobId } = ctx.action.params;
  const filter: Record<string, any> = {};

  if (rootRunId) filter.rootRunId = rootRunId;
  if (sessionId) filter.sessionId = sessionId;
  if (pipelineJobId) filter.pipelineJobId = pipelineJobId;

  if (Object.keys(filter).length === 0) {
    ctx.throw(400, 'At least one scope parameter (rootRunId, sessionId, pipelineJobId) is required.');
    return;
  }

  const repo = ctx.db.getRepository('agentSessionContext');
  const entries = (await repo.find({
    filter,
    sort: ['-updatedAt'],
  })) as any[];

  const now = Date.now();
  ctx.body = entries.map((e: any) => {
    const updatedAt = e.updatedAt ? new Date(e.updatedAt).getTime() : e.createdAt ? new Date(e.createdAt).getTime() : 0;
    const isExpired = e.ttlSeconds && updatedAt ? (now - updatedAt) / 1000 > e.ttlSeconds : false;

    // Truncate large values for list view
    let valuePreview = e.value;
    if (valuePreview && valuePreview.length > 500) {
      valuePreview = valuePreview.substring(0, 500) + `... (${valuePreview.length} chars total)`;
    }

    return {
      id: e.id,
      key: e.key,
      valuePreview,
      contentType: e.contentType,
      source: e.source,
      ttlSeconds: e.ttlSeconds,
      isExpired,
      rootRunId: e.rootRunId,
      sessionId: e.sessionId,
      createdAt: e.createdAt?.toISOString?.() || null,
      updatedAt: e.updatedAt?.toISOString?.() || null,
    };
  });

  await next();
}

/**
 * GET /api/agentSessionContext:getEntry?id=xxx
 *
 * Get full details of a single context entry (including full value).
 */
export async function getEntry(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  if (!filterByTk) {
    ctx.throw(400, 'Entry ID (filterByTk) is required.');
    return;
  }

  const repo = ctx.db.getRepository('agentSessionContext');
  const entry = await repo.findOne({ filterByTk });

  if (!entry) {
    ctx.throw(404, `Context entry ${filterByTk} not found.`);
    return;
  }

  ctx.body = entry;
  await next();
}

/**
 * POST /api/agentSessionContext:deleteEntry
 *
 * Delete a single context entry by ID.
 */
export async function deleteEntry(ctx: Context, next: Next) {
  const { filterByTk } = ctx.action.params;
  if (!filterByTk) {
    ctx.throw(400, 'Entry ID (filterByTk) is required.');
    return;
  }

  const repo = ctx.db.getRepository('agentSessionContext');
  await repo.destroy({ filterByTk });

  ctx.body = { success: true, message: `Entry ${filterByTk} deleted.` };
  await next();
}

/**
 * POST /api/agentSessionContext:clearScope
 *
 * Delete ALL entries for a given scope (rootRunId or sessionId).
 * Use when a workflow is stuck or needs to be reset.
 */
export async function clearScope(ctx: Context, next: Next) {
  const { rootRunId, sessionId } = ctx.action.params.values || ctx.action.params || {};
  const filter: Record<string, any> = {};

  if (rootRunId) filter.rootRunId = rootRunId;
  if (sessionId) filter.sessionId = sessionId;

  if (Object.keys(filter).length === 0) {
    ctx.throw(400, 'At least one scope parameter (rootRunId, sessionId) is required.');
    return;
  }

  const repo = ctx.db.getRepository('agentSessionContext');
  const deleted = await repo.destroy({ filter });

  ctx.body = {
    success: true,
    message: `Cleared ${deleted} entries for scope.`,
    deletedCount: deleted,
    scope: filter,
  };
  await next();
}

/**
 * POST /api/agentSessionContext:pruneExpired
 *
 * Force-prune all expired entries immediately (normally runs hourly via cron).
 */
export async function pruneExpired(ctx: Context, next: Next) {
  // Fix P1-1: Use class-based lookup (consistent with all other handlers)
  const kbPlugin = ctx.app.pm.get(PluginKnowledgeBaseServer) as PluginKnowledgeBaseServer | undefined;
  if (!kbPlugin?.sessionContext) {
    ctx.throw(500, 'SessionContext service not available.');
    return;
  }

  const deleted = await kbPlugin.sessionContext.pruneExpired();

  ctx.body = {
    success: true,
    message: `Pruned ${deleted} expired entries.`,
    deletedCount: deleted,
  };
  await next();
}

/**
 * POST /api/agentSessionContext:clearAll
 *
 * Nuclear option: delete ALL context entries across all scopes.
 * Use with extreme caution — this will break any running workflows.
 */
export async function clearAll(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository('agentSessionContext');
  const count = await repo.count();
  await repo.destroy({ filter: {} });

  ctx.body = {
    success: true,
    message: `Cleared ALL ${count} context entries. Warning: this may break running agent workflows.`,
    deletedCount: count,
  };
  await next();
}
