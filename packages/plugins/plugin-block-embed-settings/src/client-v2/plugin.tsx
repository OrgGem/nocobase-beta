// SPDX-License-Identifier: Apache-2.0

import { Plugin, Application } from '@nocobase/client-v2';
import { EmbedSettingsBlockModel } from './models/EmbedSettingsBlockModel';

export class PluginBlockEmbedSettingsClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const pluginName = this.options.name || 'plugin-block-embed-settings';
    const aclSnippet = `pm.${pluginName}`;

    this.pluginSettingsManager.addMenuItem({
      key: 'block-embed-settings',
      title: this.t('Embed Settings Block'),
      icon: 'BlockOutlined',
      aclSnippet,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'block-embed-settings',
      key: 'index',
      title: this.t('Embed Settings Block'),
      aclSnippet,
      componentLoader: () => import('./EmbedSettingsManager').then((m) => ({ default: m.EmbedSettingsManager })),
    });

    this.pluginSettingsManager.setPluginSettingsLink(pluginName, 'block-embed-settings');

    this.app.flowEngine.registerModels({
      EmbedSettingsBlockModel,
    });
  }
}

export default PluginBlockEmbedSettingsClient;
