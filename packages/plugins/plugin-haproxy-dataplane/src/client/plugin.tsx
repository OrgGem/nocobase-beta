// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client';
import { HAPROXY_PERMISSION_ITEMS, HAPROXY_SNIPPETS, PLUGIN_NAME, SETTINGS_KEY } from '../shared/constants';
import { HaproxyDataplaneBlock } from './HaproxyDataplaneBlock';
import { HaproxyDataplaneBlockInitializer } from './HaproxyDataplaneBlockInitializer';
import { HaproxyDataplaneBlockModel } from './models/HaproxyDataplaneBlockModel';
import { haproxyDataplaneBlockSettings } from './schemaSettings';

export class PluginHaproxyDataplaneClient extends Plugin {
  async load() {
    this.app.addComponents({
      HaproxyDataplaneBlock,
      HaproxyDataplaneBlockInitializer,
    });

    this.app.schemaSettingsManager.add(haproxyDataplaneBlockSettings);

    const initializerItem = {
      title: `{{t("HAProxy Data Plane", { ns: "${PLUGIN_NAME}" })}}`,
      Component: 'HaproxyDataplaneBlockInitializer',
    };
    this.app.schemaInitializerManager.addItem('page:addBlock', 'otherBlocks.haproxyDataplane', initializerItem);
    this.app.schemaInitializerManager.addItem('popup:common:addBlock', 'otherBlocks.haproxyDataplane', initializerItem);
    this.app.schemaInitializerManager.addItem('popup:addNew:addBlock', 'otherBlocks.haproxyDataplane', initializerItem);

    this.flowEngine.registerModels({
      HaproxyDataplaneBlockModel,
    });

    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('HAProxy Data Plane'),
      icon: 'ClusterOutlined',
      aclSnippet: HAPROXY_SNIPPETS.access,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.fleet`, {
      title: this.t('Fleet Overview'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 1,
      componentLoader: () => import('../client-v2/components/HaproxyFleetView'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.reverse-proxy`, {
      title: this.t('Reverse Proxy (In → Out)'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 5,
      componentLoader: () => import('../client-v2/components/HaproxyReverseProxyView'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.monitor`, {
      title: this.t('Live Stats & Runtime'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 10,
      componentLoader: () => import('../client-v2/components/HaproxyMonitorView'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.config`, {
      title: this.t('Configuration & Routing'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 20,
      componentLoader: () => import('../client-v2/components/HaproxyConfigView'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.transactions`, {
      title: this.t('Transactions & Reloads'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 30,
      componentLoader: () => import('../client-v2/components/HaproxyTransactionsView'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.revisions`, {
      title: this.t('Versions, Diff & Audit'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 35,
      componentLoader: () => import('../client-v2/components/HaproxyRevisionsView'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.raw`, {
      title: this.t('Raw Config & Sync'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 40,
      componentLoader: () => import('../client-v2/components/HaproxyRawConfigView'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.storage`, {
      title: this.t('SSL, Maps & Storage'),
      aclSnippet: HAPROXY_SNIPPETS.read,
      sort: 50,
      componentLoader: () => import('../client-v2/components/HaproxyStorageView'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.connections`, {
      title: this.t('Connections'),
      aclSnippet: HAPROXY_SNIPPETS.connections,
      sort: 60,
      componentLoader: () => import('../client-v2/components/HaproxyConnectionsView'),
    });

    for (const [index, item] of HAPROXY_PERMISSION_ITEMS.entries()) {
      this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.${item.key}`, {
        title: this.t(item.title),
        aclSnippet: item.aclSnippet,
        hidden: true,
        isTopLevel: false,
        sort: 100 + index,
      });
    }
  }
}

export default PluginHaproxyDataplaneClient;
