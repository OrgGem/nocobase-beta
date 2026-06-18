import { Plugin } from '@nocobase/server';
import { readdir, unlink } from 'fs/promises';
import { resolve } from 'path';
import { tmpdir } from 'os';
import WorkflowPlugin from '@nocobase/plugin-workflow';
import { COLLECTION, DEFAULTS } from '../shared/constants';
import { CarboneClient, CarboneClientConfig } from './services/carbone-client';
import { CacheManager } from './services/cache-manager';
import { RateLimiter } from './services/rate-limiter';
import { RenderLogger } from './services/render-logger';
import { getSettings, saveSettings, testConnection } from './resources/settings';
import { makeTemplateActions, makeVersionActions } from './resources/templates';
import { makeRenderActions, makeCacheActions, makeMonitoringActions } from './resources/renders';
import { makeCarboneRenderInstructionClass } from './workflow/carbone-render-instruction';

/**
 * Carbone Template Manager — server plugin.
 *
 * Phases:
 *   P1 — settings + connection + ACL skeleton
 *   P2 — templates + versions collections, upload/parse/CRUD
 *   P3 — render + content-addressable cache
 *   P4 — playground + cache management UI
 *   P5 — render logs + per-user rate limit + retention prune (this file)
 *   P6 — workflow instruction (next)
 */
export class PluginCarboneTemplateManagerServer extends Plugin {
  declare app: any;

  /** In-memory rate limiter shared across all render actions. */
  readonly rateLimiter = new RateLimiter();

  private maintenanceTimer?: NodeJS.Timeout;

  async beforeLoad() {
    // Prepare migrations directory for future schema evolution (#14).
    this.db.addMigrations({
      namespace: this.name,
      directory: resolve(__dirname, 'migrations'),
    });
  }

  /**
   * Ensure the singleton settings row exists on first install so that
   * workflow / API renders before the admin visits the UI don't fail
   * with "Carbone settings are not configured" (#5).
   */
  async install() {
    const repo = this.db.getRepository(COLLECTION.settings);
    const existing = await repo.findOne({});
    if (!existing) {
      await repo.create({ values: { ...DEFAULTS } });
    }
  }

  async load() {
    // 1. Auto-load collections
    await this.db.import({ directory: resolve(__dirname, 'collections') });

    // 1.5 Stale temp file cleanup — remove any carbone-* files left behind
    //     by a previous process crash (#8).
    this.cleanupTempFiles().catch((err) => this.app.logger.warn(`[carbone] temp file cleanup failed: ${err}`));

    // 2. Resource actions (extend default collection actions using registerActionHandlers to avoid 404s)
    const tplActions = makeTemplateActions(this);
    const renderActions = makeRenderActions(this);
    const verActions = makeVersionActions(this);
    const cacheActions = makeCacheActions(this);
    const monitoringActions = makeMonitoringActions(this);

    this.app.resourcer.registerActionHandlers({
      [`${COLLECTION.settings}:get`]: getSettings,
      [`${COLLECTION.settings}:save`]: saveSettings,
      [`${COLLECTION.settings}:testConnection`]: testConnection,

      [`${COLLECTION.templates}:upload`]: tplActions.upload,
      [`${COLLECTION.templates}:parsePlaceholders`]: tplActions.parsePlaceholders,
      [`${COLLECTION.templates}:download`]: tplActions.download,
      [`${COLLECTION.templates}:render`]: renderActions.render,
      [`${COLLECTION.templates}:renderById`]: renderActions.renderById,
      [`${COLLECTION.templates}:renderDirect`]: renderActions.renderDirect,
      [`${COLLECTION.templates}:test`]: renderActions.test,

      [`${COLLECTION.versions}:rollback`]: verActions.rollback,
      [`${COLLECTION.versions}:diffSchema`]: verActions.diffSchema,
      [`${COLLECTION.versions}:destroy`]: verActions.destroy,

      [`${COLLECTION.renderCache}:invalidate`]: cacheActions.invalidate,

      [`${COLLECTION.renderLogs}:summary`]: monitoringActions.summary,
    });

    // 2.5 Cleanup hook — purge cache rows + Carbone-side template when destroyed.
    this.db.on(`${COLLECTION.templates}.afterDestroy`, async (model: any) => {
      const id = model?.id ?? model?.dataValues?.id;
      if (!id) return;
      try {
        await new CacheManager(this.app).invalidateByTemplate(Number(id));
      } catch (err) {
        this.app.logger.warn(`[carbone] cache invalidation on destroy failed: ${err}`);
      }
      // Best-effort cleanup of Carbone-side SHA-256 entries for versions
      // that aren't shared with any remaining template/version.
      try {
        const client = await this.getCarboneClient();
        if (!client) return;
        const verRepo = this.db.getRepository(COLLECTION.versions);
        const versions = await verRepo.find({
          filter: { templateId: Number(id) },
          fields: ['id', 'carboneTemplateId'],
        });
        for (const ver of versions) {
          const carboneId = ver.carboneTemplateId;
          if (!carboneId) continue;
          // Only delete from Carbone if no other template or version references this SHA-256.
          const siblingVersions = await verRepo.count({
            filter: { carboneTemplateId: carboneId, id: { $ne: ver.id } },
          });
          if (siblingVersions > 0) continue;
          const tplRepo = this.db.getRepository(COLLECTION.templates);
          const activeTpl = await tplRepo.count({
            filter: { carboneTemplateId: carboneId, id: { $ne: Number(id) } },
          });
          if (activeTpl > 0) continue;
          await client.deleteTemplate(carboneId).catch((err) => {
            this.app.logger.warn(`[carbone] failed to delete remote template ${carboneId}: ${err}`);
          });
        }
      } catch (err) {
        this.app.logger.warn(`[carbone] remote cleanup on destroy failed: ${err}`);
      }
    });

    // 2.6 Hourly maintenance — prune expired logs + idle rate-limit windows.
    this.maintenanceTimer = setInterval(() => this.runMaintenance(), 3_600_000);
    this.app.on('beforeStop', () => {
      if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    });

    // 2.6a Log a startup warning about the in-memory rate limiter so
    //      operators of multi-instance deployments are aware of the gap.
    this.app.logger?.info(
      '[carbone] rate limiter is in-memory (single-instance only); ' +
        'multi-instance deployments should swap RateLimiter for a Redis-backed store',
    );

    // 2.7 Workflow integration (P6) — register the `carbone-render` instruction.
    const workflowPlugin = this.app.pm.get(WorkflowPlugin) as any;
    if (workflowPlugin) {
      workflowPlugin.registerInstruction('carbone-render', makeCarboneRenderInstructionClass(this));
    }

    // 3. ACL snippets — admin-only by default. Placeholders for resources
    //    that don't exist yet are scoped now to keep migrations stable.
    const ns = this.name;
    this.app.acl.registerSnippet({
      name: `pm.${ns}.connection`,
      actions: [`${COLLECTION.settings}:get`, `${COLLECTION.settings}:save`, `${COLLECTION.settings}:testConnection`],
    });
    this.app.acl.registerSnippet({
      name: `pm.${ns}.settings`,
      actions: [
        `pm.${ns}.connection`,
        `pm.${ns}.templates`,
        `pm.${ns}.render`,
        `pm.${ns}.versions`,
        `pm.${ns}.monitoring`,
      ],
    });
    this.app.acl.registerSnippet({
      name: `pm.${ns}.templates`,
      actions: [
        `${COLLECTION.templates}:list`,
        `${COLLECTION.templates}:get`,
        `${COLLECTION.templates}:create`,
        `${COLLECTION.templates}:update`,
        `${COLLECTION.templates}:destroy`,
        `${COLLECTION.templates}:upload`,
        `${COLLECTION.templates}:parsePlaceholders`,
        `${COLLECTION.templates}:download`,
      ],
    });
    this.app.acl.registerSnippet({
      name: `pm.${ns}.render`,
      actions: [
        `${COLLECTION.templates}:test`,
        `${COLLECTION.templates}:render`,
        `${COLLECTION.templates}:renderById`,
        `${COLLECTION.templates}:renderDirect`,
      ],
    });
    this.app.acl.registerSnippet({
      name: `pm.${ns}.versions`,
      actions: [`${COLLECTION.versions}:*`],
    });
    this.app.acl.registerSnippet({
      name: `pm.${ns}.monitoring`,
      actions: [
        `${COLLECTION.renderLogs}:list`,
        `${COLLECTION.renderLogs}:get`,
        `${COLLECTION.renderLogs}:destroy`,
        `${COLLECTION.renderLogs}:summary`,
        `${COLLECTION.renderCache}:list`,
        `${COLLECTION.renderCache}:get`,
        `${COLLECTION.renderCache}:destroy`,
        `${COLLECTION.renderCache}:invalidate`,
      ],
    });
  }

  /**
   * Public helper — build a CarboneClient from the current settings row.
   * Returns null when settings are missing so callers can short-circuit
   * with a useful error.
   */
  async getCarboneClient(): Promise<CarboneClient | null> {
    const repo = this.db.getRepository(COLLECTION.settings);
    const row = await repo.findOne({});
    if (!row) return null;
    const cfg: CarboneClientConfig = {
      endpoint: row.endpoint || DEFAULTS.endpoint,
      apiToken: row.apiToken,
      carboneVersion: row.carboneVersion || DEFAULTS.carboneVersion,
      timeoutMs: row.timeoutMs ?? DEFAULTS.timeoutMs,
      maxRetries: row.maxRetries ?? DEFAULTS.maxRetries,
    };
    return new CarboneClient(cfg);
  }

  /**
   * Stale temp file cleanup — scans os.tmpdir() for `carbone-*` files left
   * behind by a previous process crash and removes them.
   */
  private async cleanupTempFiles(): Promise<void> {
    const dir = tmpdir();
    const files = await readdir(dir);
    const carboneTemp = files.filter((f) => f.startsWith('carbone-'));
    if (!carboneTemp.length) return;
    await Promise.all(carboneTemp.map((f) => unlink(resolve(dir, f)).catch(() => undefined)));
    this.app.logger?.info(`[carbone] cleaned up ${carboneTemp.length} stale temp files`);
  }

  private async runMaintenance() {
    try {
      this.rateLimiter.prune();
      const removed = await new RenderLogger(this.app).pruneExpired();
      if (removed) this.app.logger.info(`[carbone] pruned ${removed} expired render logs`);
    } catch (err) {
      this.app.logger.warn(`[carbone] maintenance task failed: ${err}`);
    }
  }
}

export default PluginCarboneTemplateManagerServer;
