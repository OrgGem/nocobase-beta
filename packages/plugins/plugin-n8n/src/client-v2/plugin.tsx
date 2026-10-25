/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';

export class PluginN8nClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'n8n',
      title: this.t('n8n Integration'),
      icon: 'ApiOutlined',
      aclSnippet: `pm.${this.options.name || 'n8n'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'n8n',
      key: 'index',
      title: this.t('n8n Integration'),
      aclSnippet: `pm.${this.options.name || 'n8n'}`,
      componentLoader: () => import('./components/N8nSettingsPage').then((m) => ({ default: m.N8nSettingsPage })),
    });
  }
}

export default PluginN8nClient;
