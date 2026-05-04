import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { COLLECTION, DEFAULTS } from '../shared/constants';
import { CarboneClient, CarboneClientConfig } from './services/carbone-client';
import { CacheManager } from './services/cache-manager';
import { getSettings, saveSettings, testConnection } from './resources/settings';
import { makeTemplateActions, makeVersionActions } from './resources/templates';
import { makeRenderActions, makeCacheActions } from './resources/renders';

/**
 * P1 — Foundation skeleton for the Carbone Template Manager plugin.
 *
 * Wires up:
 *   - the singleton `carboneSettings` collection,
 *   - get/save/testConnection resource actions,
 *   - ACL snippets for every planned resource (most are empty placeholders
 *     until P2/P3/P4/P5 land).
 *
 * Subsequent phases add:
 *   P2 — templates + versions collections, upload/parse/CRUD
 *   P3 — render + cache
 *   P4 — versioning rollback + test playground
 *   P5 — monitoring dashboard + rate limit + audit
 *   P6 — workflow instruction + record action
 */
export class PluginCarboneTemplateManagerServer extends Plugin {
  async load() {
    // 1. Auto-load collections
    await this.db.import({ directory: resolve(__dirname, 'collections') });

    // 2. Resource actions
    this.app.resourceManager.define({
      name: COLLECTION.settings,
      actions: {
        get: getSettings,
        save: saveSettings,
        testConnection,
      },
    });

    const tplActions = makeTemplateActions(this);
    const renderActions = makeRenderActions(this);
    this.app.resourceManager.define({
      name: COLLECTION.templates,
      actions: {
        upload: tplActions.upload,
        parsePlaceholders: tplActions.parsePlaceholders,
        download: tplActions.download,
        renderById: renderActions.renderById,
        renderDirect: renderActions.renderDirect,
        test: renderActions.test,
      },
    });

    const verActions = makeVersionActions(this);
    this.app.resourceManager.define({
      name: COLLECTION.versions,
      actions: {
        rollback: verActions.rollback,
        diffSchema: verActions.diffSchema,
      },
    });

    const cacheActions = makeCacheActions(this);
    this.app.resourceManager.define({
      name: COLLECTION.renderCache,
      actions: {
        invalidate: cacheActions.invalidate,
      },
    });

    // 2.5 Cache invalidation hook — purge cache rows when a template is removed.
    this.db.on(`${COLLECTION.templates}.afterDestroy`, async (model: any) => {
      try {
        const id = model?.id ?? model?.dataValues?.id;
        if (!id) return;
        await new CacheManager(this.app).invalidateByTemplate(Number(id));
      } catch (err) {
        this.app.logger.warn(`[carbone] cache invalidation on destroy failed: ${err}`);
      }
    });

    // 3. ACL snippets — admin-only by default. Placeholders for resources
    //    that don't exist yet are scoped now to keep migrations stable.
    const ns = this.name;
    this.app.acl.registerSnippet({
      name: `pm.${ns}.settings`,
      actions: [
        `${COLLECTION.settings}:get`,
        `${COLLECTION.settings}:save`,
        `${COLLECTION.settings}:testConnection`,
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
        `${COLLECTION.renderLogs}:*`,
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
}

export default PluginCarboneTemplateManagerServer;
