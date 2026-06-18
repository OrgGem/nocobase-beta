import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginKnowledgeBaseClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-knowledge-base',
      title: this.t('Knowledge Base'),
      icon: 'BookOutlined',
      
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-knowledge-base',
      key: 'knowledge-base',
      title: this.t('Knowledge base'),
      aclSnippet: 'pm.plugin-knowledge-base.knowledge-base',
      componentLoader: () => import('../client/components/KnowledgeBases').then(m => ({ default: m.KnowledgeBases })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-knowledge-base',
      key: 'infrastructure',
      title: this.t('Infrastructure'),
      aclSnippet: 'pm.plugin-knowledge-base.knowledge-base',
      componentLoader: () => import('../client/components/Infrastructure').then(m => ({ default: m.Infrastructure })),
    });

  }
}

export default PluginKnowledgeBaseClient;
