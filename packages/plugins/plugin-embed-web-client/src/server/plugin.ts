// @ts-nocheck
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
import { getConfig, updateConfig } from './resources/embed-web-client';
import { downloadModel, getModelStatus } from './actions/download-model';
import { listModels, uploadModelFile, deleteModel, getModelFiles, createModelDirectory } from './actions/model-manager';
import { createModelServerMiddleware } from './middleware/model-server';

export class PluginEmbedWebClientServer extends Plugin {
  async load() {
    await this.db.import({
      directory: resolve(__dirname, 'collections'),
    });

    this.db.addMigrations({
      namespace: this.name,
      directory: resolve(__dirname, 'migrations'),
      context: { plugin: this },
    });

    this.app.use(createModelServerMiddleware(this.db, this.app), { before: 'resourcer' });

    this.app.resourceManager.define({
      name: 'embedWebClient',
      actions: {
        getConfig,
        updateConfig,
        listModels,
        uploadModelFile,
        deleteModel,
        getModelFiles,
        downloadModel,
        getModelStatus,
        createModelDirectory,
      },
    });

    this.app.resourceManager.registerActionHandler('embedWebClient:getConfig', getConfig);
    this.app.resourceManager.registerActionHandler('embedWebClient:updateConfig', updateConfig);
    this.app.resourceManager.registerActionHandler('embedWebClient:listModels', listModels);
    this.app.resourceManager.registerActionHandler('embedWebClient:uploadModelFile', uploadModelFile);
    this.app.resourceManager.registerActionHandler('embedWebClient:deleteModel', deleteModel);
    this.app.resourceManager.registerActionHandler('embedWebClient:getModelFiles', getModelFiles);
    this.app.resourceManager.registerActionHandler('embedWebClient:downloadModel', downloadModel);
    this.app.resourceManager.registerActionHandler('embedWebClient:getModelStatus', getModelStatus);
    this.app.resourceManager.registerActionHandler('embedWebClient:createModelDirectory', createModelDirectory);

    this.app.acl.allow('embedWebClient', 'getConfig', 'loggedIn');
    this.app.acl.allow('embedWebClient', 'getModelStatus', 'loggedIn');
    this.app.acl.allow('embedWebClient', 'listModels', 'loggedIn');

    this.app.acl.registerSnippet({
      name: `pm.${this.name}`,
      actions: [
        'embedWebClient:updateConfig',
        'embedWebClient:uploadModelFile',
        'embedWebClient:deleteModel',
        'embedWebClient:getModelFiles',
        'embedWebClient:downloadModel',
        'embedWebClient:createModelDirectory',
      ],
    });
  }
}

export default PluginEmbedWebClientServer;
