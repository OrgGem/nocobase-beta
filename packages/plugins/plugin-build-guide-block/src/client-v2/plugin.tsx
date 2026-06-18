import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginBuildGuideBlockClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'ai-build-guide',
      title: this.t('Build Guide Block'),
      icon: 'ReadOutlined',
      aclSnippet: 'pm.ai-build-guide',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'ai-build-guide',
      key: 'index',
      title: this.t('Build Guide Block'),
      
      componentLoader: () => import('../client/UserGuideManager').then(m => ({ default: m.UserGuideManager })),
    });

  }
}

export default PluginBuildGuideBlockClient;
