import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginAiApiClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-api',
      title: this.t('AI API Gateway'),
      icon: 'ApiOutlined',
      aclSnippet: 'pm.ai-api.configuration',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-api',
      key: 'index',
      title: this.t('Configuration'),
      
      componentLoader: () => import('../client/AiApiConfigPage'),
    });

  }
}

export default PluginAiApiClient;
