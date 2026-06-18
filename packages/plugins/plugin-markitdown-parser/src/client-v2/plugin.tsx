import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginMarkitdownParserClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'markitdown-parser',
      title: this.t('MarkItDown Parser'),
      icon: 'FileMarkdownOutlined',
      aclSnippet: 'pm.markitdown-parser',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'markitdown-parser',
      key: 'index',
      title: this.t('MarkItDown Parser'),
      
      componentLoader: () => import('../client/components/SettingsPage').then(m => ({ default: m.SettingsPage })),
    });

  }
}

export default PluginMarkitdownParserClient;
