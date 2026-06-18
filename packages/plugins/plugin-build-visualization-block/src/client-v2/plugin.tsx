import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginBuildVisualizationBlockClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-build-visualization-block',
      title: this.t('Build Visualization Block'),
      icon: 'DashboardOutlined',
      aclSnippet: 'pm.plugin-build-visualization-block.settings',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-build-visualization-block',
      key: 'index',
      title: this.t('Build Visualization Block'),
      
      componentLoader: () => import('../client/SettingsPage').then(m => ({ default: m.SettingsPage })),
    });

  }
}

export default PluginBuildVisualizationBlockClient;
