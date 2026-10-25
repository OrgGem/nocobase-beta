/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';
import { EmbedSettingsBlockModel } from './models/EmbedSettingsBlockModel';

export class PluginBlockEmbedSettingsClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'block-embed-settings',
      title: this.t('Embed Settings Block'),
      icon: 'BlockOutlined',
      aclSnippet: `pm.${this.options.name || 'block-embed-settings'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'block-embed-settings',
      key: 'index',
      title: this.t('Embed Settings Block'),
      aclSnippet: `pm.${this.options.name || 'block-embed-settings'}`,
      componentLoader: () => import('./EmbedSettingsManager').then((m) => ({ default: m.EmbedSettingsManager })),
    });

    this.app.flowEngine.registerModels({
      EmbedSettingsBlockModel,
    });
  }
}

export default PluginBlockEmbedSettingsClient;
