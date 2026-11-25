// SPDX-License-Identifier: Apache-2.0

import { Application, Plugin } from '@nocobase/client-v2';
import { HAPROXY_PERMISSION_ITEMS, HAPROXY_SNIPPETS, SETTINGS_KEY } from '../shared/constants';
import { HaproxyDataplaneBlockModel } from './models/HaproxyDataplaneBlockModel';

export class PluginHaproxyDataplaneClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.flowEngine.registerModels({
      HaproxyDataplaneBlockModel,
    });

    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('HAProxy Data Plane'),
      icon: 'ClusterOutlined',
      aclSnippet: HAPROXY_SNIPPETS.access,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'fleet',
      title: this.t('Fleet Overview'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 1,
      componentLoader: () => import('./components/HaproxyFleetView'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'reverse-proxy',
      title: this.t('Reverse Proxy (In → Out)'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 5,
      componentLoader: () => import('./components/HaproxyReverseProxyView'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'monitor',
      title: this.t('Live Stats & Runtime'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 10,
      componentLoader: () => import('./components/HaproxyMonitorView'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'config',
      title: this.t('Configuration & Routing'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 20,
      componentLoader: () => import('./components/HaproxyConfigView'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'transactions',
      title: this.t('Transactions & Reloads'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 30,
      componentLoader: () => import('./components/HaproxyTransactionsView'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'revisions',
      title: this.t('Versions, Diff & Audit'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 35,
      componentLoader: () => import('./components/HaproxyRevisionsView'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'raw',
      title: this.t('Raw Config & Sync'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 40,
      componentLoader: () => import('./components/HaproxyRawConfigView'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'storage',
      title: this.t('SSL, Maps & Storage'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 50,
      componentLoader: () => import('./components/HaproxyStorageView'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'connections',
      title: this.t('Connections'),
      aclSnippet: HAPROXY_SNIPPETS.connections,
      sort: 60,
      componentLoader: () => import('./components/HaproxyConnectionsView'),
    });

    for (const [index, item] of HAPROXY_PERMISSION_ITEMS.entries()) {
      this.pluginSettingsManager.addPageTabItem({
        menuKey: SETTINGS_KEY,
        key: item.key,
        title: this.t(item.title),
        aclSnippet: item.aclSnippet,
        hidden: true,
        sort: 100 + index,
      });
    }
  }
}

export default PluginHaproxyDataplaneClientV2;
