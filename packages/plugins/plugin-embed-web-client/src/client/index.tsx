/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, lazy } from '@nocobase/client';

const { PluginSettings } = lazy(() => import('./components/PluginSettings'), 'PluginSettings');
const { ModelManager } = lazy(() => import('./components/ModelManager'), 'ModelManager');

export class PluginEmbedWebClientClient extends Plugin {
  declare app: any;
  async load() {
    // Admin settings: two tabs — model manager + embedding configuration
    this.app.pluginSettingsManager.add('embed-web-client', {
      title: 'Web Client Embedding',
      icon: 'ThunderboltOutlined',
    });

    this.app.pluginSettingsManager.add('embed-web-client.models', {
      title: 'Models',
      Component: ModelManager,
    });

    this.app.pluginSettingsManager.add('embed-web-client.settings', {
      title: 'Settings',
      Component: PluginSettings,
    });
  }
}

export default PluginEmbedWebClientClient;
