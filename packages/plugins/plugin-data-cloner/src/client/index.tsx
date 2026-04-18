import React from 'react';
import { Plugin } from '@nocobase/client';
import { ClonerManager } from './ClonerManager';
import models from './models';

export class PluginDataClonerClient extends Plugin {
  async load() {
    this.flowEngine.registerModels(models);
    this.app.pluginSettingsManager.add('data-cloner', {
      title: 'Data Cloner',
      icon: 'DatabaseOutlined',
      Component: ClonerManager,
    });
  }
}

export default PluginDataClonerClient;
