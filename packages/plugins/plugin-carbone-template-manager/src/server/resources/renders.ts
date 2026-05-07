import { Context, Next } from '@nocobase/actions';
import { COLLECTION, CarboneOutputFormat, DEFAULTS } from '../../shared/constants';
import { CacheManager, inputMd5, stableStringify } from '../services/cache-manager';
import { RenderPipeline } from '../services/render-pipeline';
import { readAttachmentBuffer } from '../services/attachment-helper';
import { RenderLogger, RenderLogEntry } from '../services/render-logger';
import type { PluginCarboneTemplateManagerServer } from '../plugin';

/**
 * `renderById` — main public render API. Looks up the template by NocoBase id,
 * uses the current version's `carboneTemplateId`, runs the render pipeline
 * (cache + Carbone + file-manager), returns JSON with attachment URL.
 *
 * `renderDirect` — render a one-off file that hasn't been registered as a
 * managed template. Caller passes a `attachmentId` (uploaded via the
 * standard file-manager endpoint), we re-upload to Carbone (idempotent
 * SHA-256), then render. Caching still works because the key is the SHA-256.
 *
 * `test` — same as renderById but `bypassCache: true`. Used by the playground
 * (P4) to always re-render against the latest Carbone version.
 *
 * All three actions enforce the per-user rate limit and emit a row to
 * `carboneRenderLogs`.
 */
export function makeRenderActions(plugin: PluginCarboneTemplateManagerServer) {
  const logger = new RenderLogger(plugin.app);

  async function render(ctx: Context, next: Next) {
    const t0 = Date.now();
    const v = ctx.action.params.values || {};
    const templateId = v.templateId ?? ctx.action.params.filterByTk;
    const templateName = v.templateName ?? v.name;
    const requestedVersionId = v.versionId ?? ctx.action.params.versionId;
    const data = v.data ?? {};
    const format = (v.format as CarboneOutputFormat | undefined) ?? undefined;
    const filename = v.filename;
    const inline = v.inline === true || ctx.action.params.inline === 'true';

    if (!templateId && !templateName) ctx.throw(400, 'templateId or templateName is required');
    if (!(await checkRate(ctx, plugin, logger, 'renderById', { templateId: templateId || templateName }))) return;

    const filter = templateId ? { id: templateId } : { name: templateName };
    const tpl = await plugin.db
      .getRepository(COLLECTION.templates)
      .findOne({ filter, appends: ['currentVersion'] });
    if (!tpl) ctx.throw(404, 'template not found');
    if (!tpl.enabled) ctx.throw(409, 'template is disabled');
    const version = requestedVersionId
      ? await plugin.db
          .getRepository(COLLECTION.versions)
          .findOne({ filterByTk: requestedVersionId })
      : tpl.currentVersion;
    if (!version) ctx.throw(404, 'template version not found');
    if (Number(version.templateId) !== Number(tpl.id)) {
      ctx.throw(400, 'versionId does not belong to templateId');
    }
    const carboneTemplateId = version.carboneTemplateId ?? tpl.carboneTemplateId;
    if (!carboneTemplateId) ctx.throw(409, 'template has no Carbone id (re-upload required)');

    try {
      const pipeline = await buildPipeline(plugin);
      const outcome = await pipeline.render({
        templateId: tpl.id,
        versionId: version.id,
        carboneTemplateId,
        data,
        format: format ?? tpl.defaultOutputFormat,
        filename: filename ?? tpl.originalFileName?.replace(/\.[^.]+$/, '') ?? tpl.name,
        persistOutput: !inline,
      });

      ctx.set('X-Carbone-Cache', outcome.cacheHit ? 'HIT' : 'MISS');
      ctx.set('X-Carbone-Render-Ms', String(outcome.durationMs));

      if (inline && outcome.buffer) {
        ctx.type = mimeForFormat(outcome.format);
        ctx.set(
          'Content-Disposition',
          `inline; filename="${encodeURIComponent(filename ?? `${tpl.name}.${outcome.format}`)}"`,
        );
        ctx.body = outcome.buffer;
      } else {
        ctx.body = {
          attachmentId: outcome.attachmentId,
          url: outcome.url,
          format: outcome.format,
          size: outcome.size,
          cacheHit: outcome.cacheHit,
          cacheKey: outcome.cacheKey,
          durationMs: outcome.durationMs,
        };
      }

      await logger.log({
        ...baseEntry(ctx, 'renderById', 'success'),
        templateId: tpl.id,
        versionId: version.id,
        carboneTemplateId,
        format: outcome.format,
        filename,
        cacheKey: outcome.cacheKey,
        cacheHit: outcome.cacheHit,
        inputMd5: outcome.inputMd5,
        inputBytes: byteSize(data),
        outputBytes: outcome.size,
        durationMs: outcome.durationMs,
        outputAttachmentId: outcome.attachmentId,
        inputData: data,
      });
      await next();
    } catch (err: any) {
      await logger.log({
        ...baseEntry(ctx, 'renderById', 'error'),
        templateId: tpl?.id,
        versionId: version?.id ?? tpl?.currentVersionId,
        carboneTemplateId: version?.carboneTemplateId ?? tpl?.carboneTemplateId,
        format: format ?? tpl?.defaultOutputFormat,
        filename,
        inputMd5: inputMd5(data),
        inputBytes: byteSize(data),
        durationMs: Date.now() - t0,
        inputData: data,
        errorMessage: err?.message || String(err),
      });
      throw err;
    }
  }

  async function renderDirect(ctx: Context, next: Next) {
    const t0 = Date.now();
    const v = ctx.action.params.values || {};
    const { attachmentId, data, format, filename } = v;
    if (!attachmentId) ctx.throw(400, 'attachmentId is required');
    if (!(await checkRate(ctx, plugin, logger, 'renderDirect', {}))) return;

    const client = await plugin.getCarboneClient();
    if (!client) ctx.throw(400, 'Carbone settings are not configured');

    try {
      const { buffer, attachment } = await readAttachmentBuffer(plugin.app, attachmentId);
      const carboneTemplateId = await client.uploadTemplate(
        buffer,
        attachment.filename || 'inline-template',
      );

      const pipeline = await buildPipeline(plugin);
      const outcome = await pipeline.render({
        carboneTemplateId,
        data: data ?? {},
        format,
        filename,
      });

      ctx.set('X-Carbone-Cache', outcome.cacheHit ? 'HIT' : 'MISS');
      ctx.set('X-Carbone-Render-Ms', String(outcome.durationMs));

      ctx.body = {
        attachmentId: outcome.attachmentId,
        url: outcome.url,
        format: outcome.format,
        size: outcome.size,
        cacheHit: outcome.cacheHit,
        cacheKey: outcome.cacheKey,
        durationMs: outcome.durationMs,
        carboneTemplateId,
      };

      await logger.log({
        ...baseEntry(ctx, 'renderDirect', 'success'),
        carboneTemplateId,
        format: outcome.format,
        filename,
        cacheKey: outcome.cacheKey,
        cacheHit: outcome.cacheHit,
        inputMd5: outcome.inputMd5,
        inputBytes: byteSize(data ?? {}),
        outputBytes: outcome.size,
        durationMs: outcome.durationMs,
        outputAttachmentId: outcome.attachmentId,
        inputData: data ?? {},
      });
      await next();
    } catch (err: any) {
      await logger.log({
        ...baseEntry(ctx, 'renderDirect', 'error'),
        format,
        filename,
        inputBytes: byteSize(data ?? {}),
        durationMs: Date.now() - t0,
        inputData: data ?? {},
        errorMessage: err?.message || String(err),
      });
      throw err;
    }
  }

  /**
   * Bypass cache + don't persist output. Returns binary inline by default
   * for instant preview in the playground.
   */
  async function test(ctx: Context, next: Next) {
    const t0 = Date.now();
    const v = ctx.action.params.values || {};
    const templateId = v.templateId ?? ctx.action.params.filterByTk;
    const data = v.data ?? {};
    const format = v.format;

    if (!templateId) ctx.throw(400, 'templateId is required');
    if (!(await checkRate(ctx, plugin, logger, 'test', { templateId }))) return;

    const tpl = await plugin.db
      .getRepository(COLLECTION.templates)
      .findOne({ filterByTk: templateId });
    if (!tpl) ctx.throw(404, 'template not found');
    if (!tpl.enabled) ctx.throw(409, 'template is disabled');
    if (!tpl.carboneTemplateId) ctx.throw(409, 'template has no Carbone id');

    try {
      const pipeline = await buildPipeline(plugin);
      const outcome = await pipeline.render({
        templateId: tpl.id,
        versionId: tpl.currentVersionId,
        carboneTemplateId: tpl.carboneTemplateId,
        data,
        format: format ?? tpl.defaultOutputFormat,
        bypassCache: true,
        persistOutput: false,
      });

      ctx.set('X-Carbone-Cache', 'BYPASS');
      ctx.set('X-Carbone-Render-Ms', String(outcome.durationMs));
      ctx.type = mimeForFormat(outcome.format);
      ctx.set(
        'Content-Disposition',
        `inline; filename="${encodeURIComponent(`${tpl.name}-test.${outcome.format}`)}"`,
      );
      ctx.body = outcome.buffer;

      await logger.log({
        ...baseEntry(ctx, 'test', 'success'),
        templateId: tpl.id,
        versionId: tpl.currentVersionId,
        carboneTemplateId: tpl.carboneTemplateId,
        format: outcome.format,
        cacheKey: outcome.cacheKey,
        cacheHit: false,
        inputMd5: outcome.inputMd5,
        inputBytes: byteSize(data),
        outputBytes: outcome.size,
        durationMs: outcome.durationMs,
        inputData: data,
      });
      await next();
    } catch (err: any) {
      await logger.log({
        ...baseEntry(ctx, 'test', 'error'),
        templateId: tpl?.id,
        versionId: tpl?.currentVersionId,
        carboneTemplateId: tpl?.carboneTemplateId,
        format: format ?? tpl?.defaultOutputFormat,
        inputMd5: inputMd5(data),
        inputBytes: byteSize(data),
        durationMs: Date.now() - t0,
        inputData: data,
        errorMessage: err?.message || String(err),
      });
      throw err;
    }
  }

  return { render, renderById: render, renderDirect, test };
}

/**
 * Cache-management resource actions exposed under `carboneRenderCache:*`.
 */
export function makeCacheActions(plugin: PluginCarboneTemplateManagerServer) {
  async function invalidate(ctx: Context, next: Next) {
    const v = ctx.action.params.values || {};
    const cache = new CacheManager(plugin.app);
    if (v.templateId) {
      const n = await cache.invalidateByTemplate(Number(v.templateId));
      ctx.body = { ok: true, removed: n };
    } else if (v.cacheKey) {
      const row = await plugin.db
        .getRepository(COLLECTION.renderCache)
        .findOne({ filter: { cacheKey: v.cacheKey } });
      if (row) await cache.evict(row.id);
      ctx.body = { ok: true, removed: row ? 1 : 0 };
    } else {
      ctx.throw(400, 'templateId or cacheKey is required');
    }
    await next();
  }

  return { invalidate };
}

/**
 * Replay a logged render. Reads the saved `inputData` (only available when
 * `keepRawInDatabase` was true at the time of capture) and re-runs the
 * matching action via the standard pipeline.
 */
export function makeMonitoringActions(plugin: PluginCarboneTemplateManagerServer) {
  async function replay(ctx: Context, next: Next) {
    const id = ctx.action.params.filterByTk ?? ctx.action.params.values?.id;
    if (!id) ctx.throw(400, 'log id is required');
    const log = await plugin.db.getRepository(COLLECTION.renderLogs).findOne({ filterByTk: id });
    if (!log) ctx.throw(404, 'log not found');
    if (!log.inputData) ctx.throw(409, 'inputData was not retained for this log');
    if (!log.templateId) ctx.throw(409, 'replay only supports logged render/test entries');

    const pipeline = await buildPipeline(plugin);
    const tpl = await plugin.db
      .getRepository(COLLECTION.templates)
      .findOne({ filterByTk: log.templateId });
    if (!tpl) ctx.throw(404, 'template no longer exists');

    const outcome = await pipeline.render({
      templateId: tpl.id,
      versionId: tpl.currentVersionId,
      carboneTemplateId: tpl.carboneTemplateId,
      data: log.inputData,
      format: log.format,
      bypassCache: true,
      persistOutput: false,
    });

    ctx.set('X-Carbone-Cache', 'BYPASS');
    ctx.set('X-Carbone-Render-Ms', String(outcome.durationMs));
    ctx.type = mimeForFormat(outcome.format);
    const replayFilename = encodeURIComponent(`replay-${id}.${outcome.format}`);
    // Use inline only for browser-previewable formats; others download (#12).
    const disposition = PREVIEWABLE_FORMATS.has(outcome.format) ? 'inline' : 'attachment';
    ctx.set('Content-Disposition', `${disposition}; filename="${replayFilename}"`);
    ctx.body = outcome.buffer;
    await next();
  }

  /**
   * Aggregate KPIs over the last `hours` hours (default 24). Cheap because the
   * dataset is bounded by `monitoringRetentionDays`.
   */
  async function summary(ctx: Context, next: Next) {
    const hours = Number(ctx.action.params.values?.hours ?? ctx.action.params.hours ?? 24);
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await plugin.db
      .getRepository(COLLECTION.renderLogs)
      .find({ filter: { createdAt: { $gte: since } }, fields: ['status', 'cacheHit', 'durationMs', 'createdAt'] });

    const total = rows.length;
    const errors = rows.filter((r: any) => r.status === 'error').length;
    const rateLimited = rows.filter((r: any) => r.status === 'rate_limited').length;
    const success = rows.filter((r: any) => r.status === 'success');
    const hits = success.filter((r: any) => r.cacheHit).length;
    const durations = success.map((r: any) => r.durationMs ?? 0).sort((a, b) => a - b);
    const p = (q: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * q))] : 0);

    // Hourly buckets for a sparkline.
    const buckets: Record<string, { count: number; errors: number; hits: number }> = {};
    for (const r of rows) {
      const key = bucketKey((r as any).createdAt);
      const b = (buckets[key] ||= { count: 0, errors: 0, hits: 0 });
      b.count++;
      if ((r as any).status === 'error') b.errors++;
      if ((r as any).cacheHit) b.hits++;
    }

    ctx.body = {
      windowHours: hours,
      total,
      success: success.length,
      errors,
      rateLimited,
      cacheHitRatio: success.length ? hits / success.length : 0,
      latencyP50: p(0.5),
      latencyP95: p(0.95),
      latencyP99: p(0.99),
      hourly: Object.entries(buckets)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([t, b]) => ({ t, ...b })),
    };
    await next();
  }

  return { replay, summary };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function checkRate(
  ctx: Context,
  plugin: PluginCarboneTemplateManagerServer,
  logger: RenderLogger,
  action: 'renderById' | 'renderDirect' | 'test',
  extras: { templateId?: number | string },
): Promise<boolean> {
  const settings = await plugin.db.getRepository(COLLECTION.settings).findOne({});
  const limit = settings?.rateLimitPerMinute ?? DEFAULTS.rateLimitPerMinute;
  const userId = ctx.state.currentUser?.id ?? null;
  const key = `u:${userId ?? 'anon'}:${ctx.ip || ''}`;
  if (plugin.rateLimiter.acquire(key, limit)) return true;

  ctx.set('X-Carbone-Rate-Limit', String(limit));
  ctx.status = 429;
  ctx.body = { errors: [{ message: `rate limit ${limit}/min exceeded` }] };
  await logger.log({
    ...baseEntry(ctx, action, 'rate_limited'),
    templateId: extras.templateId ? Number(extras.templateId) : undefined,
    errorMessage: `rate limit ${limit}/min exceeded`,
  });
  return false;
}

function baseEntry(
  ctx: Context,
  action: 'renderById' | 'renderDirect' | 'test',
  status: RenderLogEntry['status'],
): RenderLogEntry {
  return {
    action,
    userId: ctx.state.currentUser?.id ?? null,
    roleName: ctx.state.currentRole ?? null,
    ip: ctx.ip ?? null,
    status,
  };
}

function byteSize(data: unknown): number {
  try {
    return Buffer.byteLength(stableStringify(data), 'utf8');
  } catch {
    return 0;
  }
}

function bucketKey(d: Date | string): string {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}T${String(dt.getUTCHours()).padStart(2, '0')}`;
}

async function buildPipeline(plugin: PluginCarboneTemplateManagerServer): Promise<RenderPipeline> {
  const client = await plugin.getCarboneClient();
  if (!client) throw new Error('Carbone settings are not configured');
  return new RenderPipeline(plugin.app, client, new CacheManager(plugin.app));
}

/** Formats the browser can render inline (PDF viewer, image, text). */
const PREVIEWABLE_FORMATS = new Set(['pdf', 'html', 'svg', 'txt', 'csv', 'png', 'jpg']);

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  html: 'text/html',
  txt: 'text/plain',
  csv: 'text/csv',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
};
function mimeForFormat(format: string): string {
  return MIME[format] ?? 'application/octet-stream';
}
