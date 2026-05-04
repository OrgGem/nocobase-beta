import { Context, Next } from '@nocobase/actions';
import { COLLECTION, CarboneOutputFormat } from '../../shared/constants';
import { CacheManager } from '../services/cache-manager';
import { RenderPipeline } from '../services/render-pipeline';
import { readAttachmentBuffer } from '../services/attachment-helper';
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
 */
export function makeRenderActions(plugin: PluginCarboneTemplateManagerServer) {
  async function renderById(ctx: Context, next: Next) {
    const v = ctx.action.params.values || {};
    const templateId = v.templateId ?? ctx.action.params.filterByTk;
    const data = v.data ?? {};
    const format = (v.format as CarboneOutputFormat | undefined) ?? undefined;
    const filename = v.filename;
    const inline = v.inline === true || ctx.action.params.inline === 'true';

    if (!templateId) ctx.throw(400, 'templateId is required');

    const tpl = await plugin.db
      .getRepository(COLLECTION.templates)
      .findOne({ filterByTk: templateId, appends: ['currentVersion'] });
    if (!tpl) ctx.throw(404, 'template not found');
    if (!tpl.enabled) ctx.throw(409, 'template is disabled');
    if (!tpl.carboneTemplateId) ctx.throw(409, 'template has no Carbone id (re-upload required)');

    const pipeline = await buildPipeline(plugin);

    const outcome = await pipeline.render({
      templateId: tpl.id,
      versionId: tpl.currentVersionId,
      carboneTemplateId: tpl.carboneTemplateId,
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
    await next();
  }

  async function renderDirect(ctx: Context, next: Next) {
    const v = ctx.action.params.values || {};
    const { attachmentId, data, format, filename } = v;
    if (!attachmentId) ctx.throw(400, 'attachmentId is required');

    const client = await plugin.getCarboneClient();
    if (!client) ctx.throw(400, 'Carbone settings are not configured');

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
    await next();
  }

  /**
   * Bypass cache + don't persist output. Returns binary inline by default
   * for instant preview in the playground.
   */
  async function test(ctx: Context, next: Next) {
    const v = ctx.action.params.values || {};
    const templateId = v.templateId ?? ctx.action.params.filterByTk;
    const data = v.data ?? {};
    const format = v.format;

    if (!templateId) ctx.throw(400, 'templateId is required');
    const tpl = await plugin.db
      .getRepository(COLLECTION.templates)
      .findOne({ filterByTk: templateId });
    if (!tpl) ctx.throw(404, 'template not found');
    if (!tpl.carboneTemplateId) ctx.throw(409, 'template has no Carbone id');

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
    await next();
  }

  return { renderById, renderDirect, test };
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

// ── helpers ─────────────────────────────────────────────────────────────────

async function buildPipeline(plugin: PluginCarboneTemplateManagerServer): Promise<RenderPipeline> {
  const client = await plugin.getCarboneClient();
  if (!client) throw new Error('Carbone settings are not configured');
  return new RenderPipeline(plugin.app, client, new CacheManager(plugin.app));
}

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
