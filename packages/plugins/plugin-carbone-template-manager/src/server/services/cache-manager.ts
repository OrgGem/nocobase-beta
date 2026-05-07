import { createHash } from 'crypto';
import { Application } from '@nocobase/server';
import { COLLECTION } from '../../shared/constants';

/**
 * Stable JSON stringify — sorts object keys so that `{a:1,b:2}` and
 * `{b:2,a:1}` hash to the same cacheKey.
 */
export function stableStringify(input: unknown): string {
  if (input === null || input === undefined) return 'null';
  if (typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return '[' + input.map(stableStringify).join(',') + ']';
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function buildCacheKey(
  carboneTemplateId: string,
  data: unknown,
  format: string,
  scope?: { templateId?: number; versionId?: number },
): string {
  return createHash('md5')
    .update(scope?.templateId != null ? String(scope.templateId) : '')
    .update('|')
    .update(scope?.versionId != null ? String(scope.versionId) : '')
    .update('|')
    .update(carboneTemplateId)
    .update('|')
    .update(stableStringify(data))
    .update('|')
    .update(format)
    .digest('hex');
}

export function inputMd5(data: unknown): string {
  return createHash('md5').update(stableStringify(data)).digest('hex');
}

export interface CacheLookupHit {
  status: 'hit';
  cacheKey: string;
  attachmentId: number;
  url: string;
  sizeBytes: number;
  format: string;
  rowId: number;
}
export interface CacheLookupMiss {
  status: 'miss';
  cacheKey: string;
}

export class CacheManager {
  constructor(private readonly app: Application) {}

  /**
   * Find a fresh cache row for the given key. Returns 'miss' when:
   *  - no row,
   *  - the row has expired,
   *  - the linked attachment was deleted.
   */
  async lookup(cacheKey: string): Promise<CacheLookupHit | CacheLookupMiss> {
    const row = await this.app.db
      .getRepository(COLLECTION.renderCache)
      .findOne({ filter: { cacheKey } });
    if (!row) return { status: 'miss', cacheKey };

    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
      await this.evict(row.id);
      return { status: 'miss', cacheKey };
    }

    const attachment = await this.app.db
      .getRepository('attachments')
      .findOne({ filterByTk: row.outputAttachmentId });
    if (!attachment) {
      // Backing file disappeared — drop the row and treat as miss.
      await this.evict(row.id);
      return { status: 'miss', cacheKey };
    }

    // Bump hit stats (best-effort, don't block on failure).
    this.app.db
      .getRepository(COLLECTION.renderCache)
      .update({
        filterByTk: row.id,
        values: { hitCount: (row.hitCount ?? 0) + 1, lastHitAt: new Date() },
      })
      .catch((err) => this.app.logger.warn(`[carbone] cache hit-count update failed: ${err}`));

    const fileManager = this.app.pm.get('file-manager') as any;
    let url = attachment.url || '';
    try {
      url = decodeURIComponent(await fileManager.getFileURL(attachment));
    } catch {
      // best-effort
    }
    return {
      status: 'hit',
      cacheKey,
      attachmentId: attachment.id,
      url,
      sizeBytes: row.sizeBytes ?? attachment.size ?? 0,
      format: row.format,
      rowId: row.id,
    };
  }

  async store(values: {
    cacheKey: string;
    templateId?: number;
    versionId?: number;
    carboneTemplateId: string;
    format: string;
    inputMd5: string;
    outputAttachmentId: number;
    sizeBytes: number;
    ttlSeconds: number;
    cacheMaxSize?: number;
  }): Promise<void> {
    const expiresAt = values.ttlSeconds > 0 ? new Date(Date.now() + values.ttlSeconds * 1000) : null;
    const repo = this.app.db.getRepository(COLLECTION.renderCache);

    // Upsert by cacheKey — race-safe enough for our use case.
    const existing = await repo.findOne({ filter: { cacheKey: values.cacheKey } });
    if (existing) {
      await repo.update({
        filterByTk: existing.id,
        values: { ...values, expiresAt, hitCount: 0, lastHitAt: null },
      });
    } else {
      await repo.create({ values: { ...values, expiresAt } });
    }

    // Enforce cacheMaxSize via LRU eviction (#3).
    if (values.cacheMaxSize && values.cacheMaxSize > 0) {
      await this.enforceSizeLimit(values.cacheMaxSize);
    }
  }

  /**
   * Drop a single cache row plus its backing attachment.
   */
  async evict(rowId: number): Promise<void> {
    const repo = this.app.db.getRepository(COLLECTION.renderCache);
    const row = await repo.findOne({ filterByTk: rowId });
    if (!row) return;
    await repo.destroy({ filterByTk: rowId });
    if (row.outputAttachmentId) {
      await this.app.db
        .getRepository('attachments')
        .destroy({ filterByTk: row.outputAttachmentId })
        .catch(() => undefined);
    }
  }

  /**
   * Purge every cache row that belongs to a template (used when the template
   * is deleted, or as a manual "clear cache" action).
   */
  async invalidateByTemplate(templateId: number): Promise<number> {
    const repo = this.app.db.getRepository(COLLECTION.renderCache);
    const rows = await repo.find({ filter: { templateId } });
    for (const row of rows) await this.evict(row.id);
    return rows.length;
  }

  /**
   * Evict oldest cache entries (by lastHitAt) until total size is at or below
   * `maxSize`. Prevents unbounded cache growth (#3).
   */
  private async enforceSizeLimit(maxSize: number): Promise<void> {
    const repo = this.app.db.getRepository(COLLECTION.renderCache);
    const allRows = await repo.find({
      fields: ['id', 'sizeBytes', 'lastHitAt'],
      sort: ['lastHitAt'], // oldest first — LRU eviction order
    });

    let totalSize = 0;
    for (const row of allRows) totalSize += row.sizeBytes ?? 0;

    for (const row of allRows) {
      if (totalSize <= maxSize) break;
      totalSize -= row.sizeBytes ?? 0;
      await this.evict(row.id);
    }
  }
}
