/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
