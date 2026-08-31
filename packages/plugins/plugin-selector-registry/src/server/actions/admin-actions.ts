import type { ClientCandidate, SelectorType } from '../../constants';
import { SelectorRegistryError } from '../services/errors';
import type { FeedbackService } from '../services/feedback-service';
import type { AnyRecord, DatabaseLike, ResolvePipeline } from '../services/resolve-pipeline';
import type { SelectorSettingsService } from '../services/settings-service';
import { sendError } from './client-actions';
import { read, toNumber } from '../utils/record-helpers';

type ActionContext = {
  request: { body?: unknown };
  body?: unknown;
  status?: number;
};

export interface AdminActionsDeps {
  database: DatabaseLike;
  pipeline: ResolvePipeline;
  feedback: FeedbackService;
  settings: SelectorSettingsService;
  pruneLogs: () => Promise<{ removedResolveLogs: number; removedFeedbacks: number }>;
}

const bodyOf = (ctx: ActionContext): Record<string, unknown> =>
  ctx.request.body && typeof ctx.request.body === 'object' ? (ctx.request.body as Record<string, unknown>) : {};

const toId = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const createAdminActions = (deps: AdminActionsDeps) => {
  const getSettings = async (ctx: ActionContext) => {
    try {
      ctx.body = await deps.settings.get();
    } catch (error) {
      sendError(ctx, error);
    }
  };

  const updateSettings = async (ctx: ActionContext) => {
    try {
      ctx.body = await deps.settings.update(bodyOf(ctx));
    } catch (error) {
      sendError(ctx, error);
    }
  };

  const stats = async (ctx: ActionContext) => {
    try {
      const entriesRepo = deps.database.getRepository('selectorEntries');
      const logsRepo = deps.database.getRepository('selectorResolveLogs');
      const feedbacksRepo = deps.database.getRepository('selectorFeedbacks');
      const appsRepo = deps.database.getRepository('selectorApps');

      // Aggregation-based stats: use count() and groupBy where supported by the
      // repository layer instead of loading all rows into memory. The FakeDatabase
      // used in unit tests implements these methods too so the same code path is
      // exercised everywhere.
      const [totalEntries, totalApps, byStatusCounts, recentLogs, recentFeedbacks] = await Promise.all([
        entriesRepo.count(),
        appsRepo.count(),
        Promise.all(
          ['probation', 'active', 'degraded', 'quarantined', 'disabled'].map(async (status) => {
            const count = await entriesRepo.count({ filter: { status } });
            return [status, count] as const;
          }),
        ),
        logsRepo.find({ sort: ['-createdAt'], limit: 500 }),
        feedbacksRepo.find({ sort: ['-createdAt'], limit: 500 }),
      ]);

      const pathCounts: Record<string, number> = {};
      for (const log of recentLogs) {
        const path = String(read(log, 'path') ?? 'unknown');
        pathCounts[path] = (pathCounts[path] ?? 0) + 1;
      }
      const outcomeCounts: Record<string, number> = {};
      for (const feedback of recentFeedbacks) {
        const outcome = String(read(feedback, 'outcome') ?? 'unknown');
        outcomeCounts[outcome] = (outcomeCounts[outcome] ?? 0) + 1;
      }

      const cacheHits = pathCounts['cache_hit'] ?? 0;
      const lookups = cacheHits + (pathCounts['registry'] ?? 0);

      // Top failing: fetch only the 10 highest-fail-count entries via sort+limit
      // instead of loading every entry and sorting in memory.
      const topFailingRows = await entriesRepo.find({ sort: ['-failCount'], limit: 10 });
      const topFailing = topFailingRows.map((entry) => ({
        id: read(entry, 'id'),
        elementKey: String(read(entry, 'elementKey') ?? ''),
        name: (read(entry, 'name') as string | null) ?? null,
        status: String(read(entry, 'status') ?? ''),
        failCount: toNumber(read(entry, 'failCount')),
        confidence: toNumber(read(entry, 'confidence')),
      }));

      ctx.body = {
        entries: {
          total: totalEntries,
          byStatus: Object.fromEntries(byStatusCounts),
        },
        apps: { total: totalApps },
        recentResolves: {
          sampled: recentLogs.length,
          byPath: pathCounts,
          cacheHitRate: lookups > 0 ? Math.round((cacheHits / lookups) * 10000) / 10000 : null,
        },
        recentFeedback: { sampled: recentFeedbacks.length, byOutcome: outcomeCounts },
        topFailing,
      };
    } catch (error) {
      sendError(ctx, error);
    }
  };

  // Re-run the healing pipeline for one entry in forced dry-run mode so admins
  // can preview what self-healing would do without touching live state.
  const revalidate = async (ctx: ActionContext) => {
    try {
      const payload = bodyOf(ctx);
      const entryId = toId(payload.entryId);
      if (!entryId) {
        throw new SelectorRegistryError('NOT_FOUND', 400, 'A valid "entryId" is required.');
      }
      const entry = await deps.database.getRepository('selectorEntries').findOne({ filterByTk: entryId });
      if (!entry) {
        throw new SelectorRegistryError('NOT_FOUND', 404, 'Selector entry not found.');
      }
      const app = await deps.database.getRepository('selectorApps').findOne({
        filter: { id: read(entry, 'appId') },
      });
      if (!app) {
        throw new SelectorRegistryError('APP_NOT_FOUND', 404, 'The entry app no longer exists.');
      }

      const response = await deps.pipeline.resolve(
        {
          app: String(read(app, 'name')),
          elementKey: String(read(entry, 'elementKey')),
          selector: (read(entry, 'currentSelector') as string | null) ?? undefined,
          selectorType: (read(entry, 'selectorType') as SelectorType | undefined) ?? 'css',
          failureType: 'not_found',
          domSnippet: typeof payload.domSnippet === 'string' ? payload.domSnippet : undefined,
          candidates: Array.isArray(payload.candidates) ? (payload.candidates as ClientCandidate[]) : undefined,
          agentId: 'admin-revalidate',
        },
        { forceDryRun: true },
      );
      ctx.body = response;
    } catch (error) {
      sendError(ctx, error);
    }
  };

  // Manual version selection: promote any historical version to active.
  const rollbackVersion = async (ctx: ActionContext) => {
    try {
      const payload = bodyOf(ctx);
      const entryId = toId(payload.entryId);
      const versionId = toId(payload.versionId);
      if (!entryId || !versionId) {
        throw new SelectorRegistryError('NOT_FOUND', 400, 'Valid "entryId" and "versionId" are required.');
      }
      const entriesRepo = deps.database.getRepository('selectorEntries');
      const versionsRepo = deps.database.getRepository('selectorVersions');
      const entry = await entriesRepo.findOne({ filterByTk: entryId });
      const target = await versionsRepo.findOne({ filterByTk: versionId });
      if (!entry || !target || toNumber(read(target, 'entryId')) !== entryId) {
        throw new SelectorRegistryError('NOT_FOUND', 404, 'Entry or version not found.');
      }

      await versionsRepo.update({
        filter: { entryId, status: 'active' },
        values: { status: 'superseded' },
      });
      await versionsRepo.update({
        filterByTk: versionId,
        values: { status: 'active', rolledBackAt: null },
      });
      const nextVersion = toNumber(read(entry, 'version'), 1) + 1;
      await entriesRepo.update({
        filterByTk: entryId,
        values: {
          currentSelector: read(target, 'selector'),
          selectorType: read(target, 'selectorType') ?? 'css',
          signature: read(target, 'signatureAtCapture') ?? read(entry, 'signature'),
          status: 'active',
          confidence: 1,
          confidenceUpdatedAt: new Date().toISOString(),
          failStreak: 0,
          probationSuccessCount: 0,
          version: nextVersion,
          resolvedBy: 'manual',
          lastResolvedAt: new Date().toISOString(),
        },
      });
      ctx.body = {
        entryId,
        versionId,
        selector: read(target, 'selector'),
        selectorType: read(target, 'selectorType') ?? 'css',
        version: nextVersion,
        status: 'active',
      };
    } catch (error) {
      sendError(ctx, error);
    }
  };

  const pruneLogs = async (ctx: ActionContext) => {
    try {
      ctx.body = await deps.pruneLogs();
    } catch (error) {
      sendError(ctx, error);
    }
  };

  return { getSettings, updateSettings, stats, revalidate, rollbackVersion, pruneLogs };
};
