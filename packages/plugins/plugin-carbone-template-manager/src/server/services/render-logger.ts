import { Application } from '@nocobase/server';
import { COLLECTION, DEFAULTS } from '../../shared/constants';

/** Maximum size (bytes) for `inputData` stored in logs. */
const MAX_INPUT_DATA_BYTES = 100 * 1024; // 100 KB

export interface RenderLogEntry {
  action: 'renderById' | 'renderDirect' | 'test';
  templateId?: number | null;
  versionId?: number | null;
  carboneTemplateId?: string | null;
  format?: string | null;
  filename?: string | null;
  userId?: number | null;
  roleName?: string | null;
  ip?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean | null;
  inputMd5?: string | null;
  inputBytes?: number | null;
  outputBytes?: number | null;
  durationMs?: number | null;
  status: 'success' | 'error' | 'rate_limited';
  errorMessage?: string | null;
  inputData?: unknown;
  outputAttachmentId?: number | null;
}

/**
 * Persist render telemetry into `carboneRenderLogs`. Honors:
 *   - `enableMonitoring` — full short-circuit when off.
 *   - `keepRawInDatabase` — inputData is dropped when false.
 *   - `monitoringRetentionDays` — sets `expiresAt` so cleanup is O(index).
 *
 * All writes are best-effort: a failed log MUST NOT break the render itself.
 */
export class RenderLogger {
  constructor(private readonly app: Application) {}

  async log(entry: RenderLogEntry): Promise<void> {
    try {
      const settings = await this.loadSettings();
      if (settings.enableMonitoring === false) return;

      const retention = settings.monitoringRetentionDays ?? DEFAULTS.monitoringRetentionDays;
      const expiresAt = retention > 0 ? new Date(Date.now() + retention * 86_400_000) : null;

      const values: any = { ...entry, expiresAt };
      if (!settings.keepRawInDatabase) {
        values.inputData = null;
      } else if (values.inputData != null) {
        // Truncate oversized inputData to prevent DB bloat (#11).
        const serialized = JSON.stringify(values.inputData);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_DATA_BYTES) {
          values.inputData = { _truncated: true, _originalBytes: entry.inputBytes };
        }
      }

      await this.app.db.getRepository(COLLECTION.renderLogs).create({ values });
    } catch (err) {
      this.app.logger.warn(`[carbone] render log write failed: ${err}`);
    }
  }

  /**
   * Drop logs whose retention deadline has passed. Uses `createdAt` instead
   * of `expiresAt` so that changes to `monitoringRetentionDays` apply
   * retroactively to older rows (#13).
   */
  async pruneExpired(): Promise<number> {
    try {
      const settings = await this.loadSettings();
      const retention = settings.monitoringRetentionDays ?? DEFAULTS.monitoringRetentionDays;
      if (retention <= 0) return 0;

      const cutoff = new Date(Date.now() - retention * 86_400_000);
      const repo = this.app.db.getRepository(COLLECTION.renderLogs);
      const rows = await repo.find({ filter: { createdAt: { $lt: cutoff } }, fields: ['id'] });
      if (!rows.length) return 0;
      await repo.destroy({ filter: { id: rows.map((r: any) => r.id) } });
      return rows.length;
    } catch (err) {
      this.app.logger.warn(`[carbone] log prune failed: ${err}`);
      return 0;
    }
  }

  private async loadSettings() {
    const row = await this.app.db.getRepository(COLLECTION.settings).findOne({});
    return row?.toJSON() ?? { ...DEFAULTS };
  }
}

