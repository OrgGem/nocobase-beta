/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginEmbedWebClientClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'embed-web-client',
      title: this.t('Web Client Embedding'),
      icon: 'ThunderboltOutlined',
      aclSnippet: `pm.${this.options.name || 'embed-web-client'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'embed-web-client',
      key: 'models',
      title: this.t('Models'),
      aclSnippet: `pm.${this.options.name || 'embed-web-client'}`,
      componentLoader: () => import('../client/components/ModelManager').then((m) => ({ default: m.ModelManager })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'embed-web-client',
      key: 'settings',
      title: this.t('Settings'),
      aclSnippet: `pm.${this.options.name || 'embed-web-client'}`,
      componentLoader: () => import('../client/components/PluginSettings').then((m) => ({ default: m.PluginSettings })),
    });
  }
}

export default PluginEmbedWebClientClient;
