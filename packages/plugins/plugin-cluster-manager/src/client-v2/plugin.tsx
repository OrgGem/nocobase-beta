// SPDX-License-Identifier: Apache-2.0

import { Plugin, Application } from '@nocobase/client-v2';
import { setupClientSafeCache } from './utils/clientSafeCache';
import { setupRequestDedupAndCache } from './utils/requestDedupInterceptor';

export class PluginClusterManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    setupClientSafeCache(this.app.apiClient, this.app.eventBus);
    setupRequestDedupAndCache(this.app.apiClient);
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-cluster-manager',
      title: this.t('Cluster Manager'),
      icon: 'DashboardOutlined',
      aclSnippet: `pm.${this.options.name || 'plugin-cluster-manager'}`,
    });

    // The shared settings screens already consume V2 hooks.
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-cluster-manager',
      key: 'index',
      title: this.t('Cluster Manager'),
      aclSnippet: `pm.${this.options.name || 'plugin-cluster-manager'}`,

      componentLoader: () =>
        import('../client/ClusterManagerLayout').then((m) => ({ default: m.ClusterManagerLayout })),
    });
  }
}

export default PluginClusterManagerClient;
