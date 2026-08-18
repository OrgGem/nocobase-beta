import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginClusterManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-cluster-manager',
      title: this.t('Cluster Manager'),
      icon: 'DashboardOutlined',
    });

    // All screens (including Worker template) live in the shared
    // ClusterManagerLayout so the v1 and v2 runtimes stay functionally in
    // sync. Intentional exception to the "v2 never imports the client dir"
    // rule: the shared components are runtime-agnostic and none of them
    // import the @nocobase/client package, so nothing v1-specific leaks
    // into the v2 bundle.
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-cluster-manager',
      key: 'index',
      title: this.t('Cluster Manager'),

      componentLoader: () =>
        import('../client/ClusterManagerLayout').then((m) => ({ default: m.ClusterManagerLayout })),
    });
  }
}

export default PluginClusterManagerClient;
