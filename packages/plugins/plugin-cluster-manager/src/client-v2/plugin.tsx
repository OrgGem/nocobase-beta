import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginClusterManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-cluster-manager',
      title: this.t('Cluster Manager'),
      icon: 'DashboardOutlined',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-cluster-manager',
      key: 'index',
      title: this.t('Cluster Manager'),

      componentLoader: () =>
        import('../client/ClusterManagerLayout').then((m) => ({ default: m.ClusterManagerLayout })),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-cluster-manager',
      key: 'worker-template',
      title: this.t('Worker template'),
      componentLoader: () => import('./WorkerTemplateVariables'),
    });
  }
}

export default PluginClusterManagerClient;
