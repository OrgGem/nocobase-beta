import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginBuildUiTemplateClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-build-ui-template',
      title: this.t('Build UI Template'),
      icon: 'LayoutOutlined',
      aclSnippet: 'pm.ai-build-ui-template',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-build-ui-template',
      key: 'index',
      title: this.t('Build UI Template'),
      
      componentLoader: () => import('../client/BuildUITemplateManager').then(m => ({ default: m.BuildUITemplateManager })),
    });

  }
}

export default PluginBuildUiTemplateClient;
