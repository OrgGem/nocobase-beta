import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';
import { EmbedSettingsBlockModel } from '../client/models/EmbedSettingsBlockModel';

export class PluginBlockEmbedSettingsClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'block-embed-settings',
      title: this.t('Embed Settings Block'),
      icon: 'BlockOutlined',
      aclSnippet: 'pm.block-embed-settings',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'block-embed-settings',
      key: 'index',
      title: this.t('Embed Settings Block'),
      
      componentLoader: () => import('../client/EmbedSettingsManager').then(m => ({ default: m.EmbedSettingsManager })),
    });

    this.app.flowEngine.registerModels({
      EmbedSettingsBlockModel,
    });
  }
}

export default PluginBlockEmbedSettingsClient;
