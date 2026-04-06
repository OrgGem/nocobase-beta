/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { resolve } from 'path';
import { getConfig, updateConfig, storeVectors } from './resources/embed-web-client';
import { downloadModel, getModelStatus } from './actions/download-model';
import { listModels, uploadModelFile, deleteModel, getModelFiles } from './actions/model-manager';
import { createModelServerMiddleware } from './middleware/model-server';
import { ServerEmbeddingPipeline } from './pipeline/server-embedding';

export class PluginEmbedWebClientServer extends Plugin {
  private serverEmbeddingPipeline: ServerEmbeddingPipeline;

  async beforeLoad() {
    // Extend aiKnowledgeBases with embedModelId + embedMode fields (declared here,
    // columns added via migration 20260406000000-add-kb-embed-fields.ts)
    // Must be in beforeLoad() so other plugins see these fields during their load() phase.
    this.db.extendCollection({
      name: 'aiKnowledgeBases',
      fields: [
        {
          // ID string of the embedding model to use (e.g. "Xenova/all-MiniLM-L6-v2").
          // null = use the plugin-level default from embedWebClientConfig.
          type: 'string',
          name: 'embedModelId',
        },
        {
          // 'client' = browser ONNX  |  'server' = NocoBase ONNX
          type: 'string',
          name: 'embedMode',
          defaultValue: 'client',
        },
      ],
    });
  }

  async load() {
    // Register embedWebClientConfig collection
    await this.importCollections(resolve(__dirname, 'collections'));

    // Register migration
    this.db.addMigrations({
      namespace: this.name,
      directory: resolve(__dirname, 'migrations'),
      context: { plugin: this },
    });

    // Serve bundled/uploaded model files at GET /embed-web-client/models/**
    this.app.use(createModelServerMiddleware(), { before: 'resourcer' });

    // Server-side embedding pipeline (used when embedMode = 'server')
    this.serverEmbeddingPipeline = new ServerEmbeddingPipeline(this.db);

    // Hook: when a document is created for a server-mode WEB_CLIENT_EMBED KB,
    // trigger server-side ONNX embedding automatically.
    this.db.on('aiKnowledgeBaseDocuments.afterCreate', async (model: any) => {
      try {
        const kbRepo = this.db.getRepository('aiKnowledgeBases');
        const kb = await kbRepo.findOne({ filter: { id: model.knowledgeBaseId } });
        if (kb?.type === 'WEB_CLIENT_EMBED' && kb.embedMode === 'server') {
          // Run asynchronously — don't block the HTTP response
          setImmediate(async () => {
            try {
              await this.serverEmbeddingPipeline.processDocument(model.id);
            } catch (err: any) {
              this.log.error(`Server embedding failed for document ${model.id}: ${err.message}`);
            }
          });
        }
      } catch (err: any) {
        this.log.warn(`embedMode check failed: ${err.message}`);
      }
    });

    // Register all resource actions
    this.app.resourceManager.define({
      name: 'embedWebClient',
      actions: {
        // config
        getConfig,
        updateConfig,
        // client embedding flow
        storeVectors,
        // model management
        listModels,
        uploadModelFile,
        deleteModel,
        getModelFiles,
        downloadModel,
        getModelStatus,
      },
    });

    // ACL: public actions available to any logged-in user
    this.app.acl.allow('embedWebClient', 'getConfig', 'loggedIn');
    this.app.acl.allow('embedWebClient', 'getModelStatus', 'loggedIn');
    this.app.acl.allow('embedWebClient', 'listModels', 'loggedIn');
    this.app.acl.allow('embedWebClient', 'storeVectors', 'loggedIn');

    // ACL: admin-only actions — gated via snippet so only users with plugin-manager
    // permission (admins) can access updateConfig, uploadModelFile, etc.
    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'embedWebClient:updateConfig',
        'embedWebClient:uploadModelFile',
        'embedWebClient:deleteModel',
        'embedWebClient:getModelFiles',
        'embedWebClient:downloadModel',
      ],
    });
  }
}

export default PluginEmbedWebClientServer;
