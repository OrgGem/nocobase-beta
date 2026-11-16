// SPDX-License-Identifier: Apache-2.0

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
