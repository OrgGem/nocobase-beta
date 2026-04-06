/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

/**
 * DocPixie Plugin — Server Plugin Class
 *
 * NocoBase plugin that provides adaptive RAG document analysis capabilities.
 * Uses NocoBase's plugin-ai infrastructure for LLM access instead of standalone providers.
 *
 * Lifecycle:
 *   afterAdd → beforeLoad → load → install (first time) → afterEnable
 *
 * Depends on: @nocobase/plugin-ai (for LLM service registry)
 */

import { Plugin } from '@nocobase/server';
import path from 'node:path';
import PluginAIServer from '@nocobase/plugin-ai';
import { DocPixieService } from './services/DocPixieService';
import { createDocPixieQueryTool } from './tools/docpixie-query-tool';

export class PluginDocPixieServer extends Plugin {
  service: DocPixieService;
  private _aiPlugin: PluginAIServer;

  get aiPlugin(): PluginAIServer {
    if (!this._aiPlugin) {
      this._aiPlugin = this.pm.get(PluginAIServer) as PluginAIServer;
    }
    return this._aiPlugin;
  }

  async afterAdd() {}

  async beforeLoad() {}

  async load() {
    // 1. Import collection definitions
    await this.importCollections(path.resolve(__dirname, 'collections'));

    // 2. Create DocPixie service
    this.service = new DocPixieService(this.app, this.db, this.app.logger);

    // 3. Register REST API actions
    this.registerActions();

    // 3.1 Register AI tool integration (if plugin-ai is enabled)
    this.registerAITools();

    // 4. Set ACL permissions
    this.setPermissions();

    // 5. Initialize service (deferred — collections may not exist yet on first load)
    this.app.on('afterStart', async () => {
      try {
        await this.service.initialize();
      } catch (err) {
        this.app.logger.warn('DocPixie: Service initialization deferred — configure settings first.', err);
      }
    });
  }

  private registerAITools() {
    try {
      const aiPlugin = this.aiPlugin;
      if (!aiPlugin?.ai?.toolsManager) {
        this.app.logger.warn('DocPixie: plugin-ai not available, skip AI tool registration.');
        return;
      }

      aiPlugin.ai.toolsManager.registerTools(createDocPixieQueryTool(this.service));
      this.app.logger.info('DocPixie: AI tool registered successfully.');
    } catch (error) {
      this.app.logger.warn('DocPixie: Failed to register AI tool, continue without AI integration.', error);
    }
  }

  // ═══════════════════════════════════════════
  // REST API Actions
  // ═══════════════════════════════════════════

  private registerActions() {
    // ── Documents Resource ──
    this.app.resourceManager.define({
      name: 'docpixie',
      actions: {
        // GET /api/docpixie:listDocuments
        listDocuments: async (ctx, next) => {
          const { limit, offset, status } = ctx.action.params;
          ctx.body = await this.service.listDocuments({ limit, offset, status });
          await next();
        },

        // GET /api/docpixie:getDocument?filterByTk=<id>
        getDocument: async (ctx, next) => {
          const { filterByTk } = ctx.action.params;
          const doc = await this.service.getDocument(Number(filterByTk));
          if (!doc) {
            ctx.throw(404, 'Document not found');
          }
          ctx.body = doc;
          await next();
        },

        // POST /api/docpixie:processDocument
        processDocument: async (ctx, next) => {
          const { filePath, name } = ctx.action.params.values || {};
          if (!filePath) {
            ctx.throw(400, 'filePath is required');
          }
          if (typeof filePath !== 'string') {
            ctx.throw(400, 'filePath must be a string');
          }
          // Guard against path traversal — resolve and verify it stays within cwd
          const storageRoot = path.resolve(process.cwd());
          const resolvedPath = path.resolve(filePath);
          if (!resolvedPath.startsWith(storageRoot + path.sep) && resolvedPath !== storageRoot) {
            ctx.throw(400, 'filePath must be within the application storage root');
          }
          const userId = ctx.state?.currentUser?.id;
          const documentId = await this.service.processDocument(resolvedPath, { name, userId });
          ctx.body = { id: documentId, status: 'processing' };
          await next();
        },

        // DELETE /api/docpixie:deleteDocument?filterByTk=<id>
        deleteDocument: async (ctx, next) => {
          const { filterByTk } = ctx.action.params;
          const deleted = await this.service.deleteDocument(Number(filterByTk));
          ctx.body = { deleted };
          await next();
        },

        // POST /api/docpixie:query
        query: async (ctx, next) => {
          const { query, documentIds, strategy, conversationHistory } = ctx.action.params.values || {};
          if (!query) {
            ctx.throw(400, 'query is required');
          }
          const result = await this.service.query({
            query,
            documentIds,
            strategy,
            conversationHistory,
          });
          ctx.body = result;
          await next();
        },

        // GET /api/docpixie:getConfig
        getConfig: async (ctx, next) => {
          ctx.body = await this.service.getConfig();
          await next();
        },

        // POST /api/docpixie:updateConfig
        updateConfig: async (ctx, next) => {
          const config = ctx.action.params.values || {};
          await this.service.updateConfig(config);
          ctx.body = { ok: true };
          await next();
        },
      },
    });
  }

  // ═══════════════════════════════════════════
  // ACL Permissions
  // ═══════════════════════════════════════════

  private setPermissions() {
    // Admin snippet — full access to docpixie resource
    this.app.acl.registerSnippet({
      name: `pm.${this.name}.docpixie`,
      actions: ['docpixie:*'],
    });

    // Allow logged-in users to list/get documents and query
    this.app.acl.allow('docpixie', 'listDocuments', 'loggedIn');
    this.app.acl.allow('docpixie', 'getDocument', 'loggedIn');
    this.app.acl.allow('docpixie', 'query', 'loggedIn');
    this.app.acl.allow('docpixie', 'getConfig', 'loggedIn');
  }

  // ═══════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════

  async install() {
    // Create default config record if none exists
    const configRepo = this.db.getRepository('docpixie_config');
    const existing = await configRepo.findOne({});
    if (!existing) {
      await configRepo.create({
        values: {
          analysisStrategy: 'hybrid',
          ocrProvider: 'none',
          maxPagesPerTask: 5,
          maxTasksPerPlan: 4,
        },
      });
    }
  }

  async afterEnable() {}

  async afterDisable() {}

  async remove() {}
}

export default PluginDocPixieServer;
