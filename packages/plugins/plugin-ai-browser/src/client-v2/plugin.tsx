import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginAiBrowserClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-browser',
      title: this.t('AI Browser'),
      icon: 'GlobalOutlined',
      aclSnippet: 'pm.ai-browser',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-browser',
      key: 'index',
      title: this.t('AI Browser'),
      
      componentLoader: () => import('../client/AIBrowserManager').then(m => ({ default: m.AIBrowserManager })),
    });

  }
}

export default PluginAiBrowserClient;
