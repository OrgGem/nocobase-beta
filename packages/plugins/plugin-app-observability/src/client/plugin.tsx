import { Plugin } from '@nocobase/client';
import React from 'react';

const MENU_KEY = 'plugin-app-observability';
const ACL_SNIPPET = 'pm.plugin-app-observability';

const OverviewPage = React.lazy(() => import('../client-v2/pages/OverviewPage'));
const NodesPage = React.lazy(() => import('../client-v2/pages/NodesPage'));
const ServicesPage = React.lazy(() => import('../client-v2/pages/ServicesPage'));
const CapacityPage = React.lazy(() => import('../client-v2/pages/CapacityPage'));
const SettingsPage = React.lazy(() => import('../client-v2/pages/SettingsPage'));

export class PluginAppObservabilityClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(MENU_KEY, {
      icon: 'FundProjectionScreenOutlined',
      title: this.t('App observability'),
      aclSnippet: ACL_SNIPPET,
    });

    this.addPage('index', 'Overview', OverviewPage, 1);
    this.addPage('nodes', 'Nodes', NodesPage, 2);
    this.addPage('services', 'Services', ServicesPage, 3);
    this.addPage('capacity', 'Capacity', CapacityPage, 4);
    this.addPage('settings', 'Settings', SettingsPage, 5);
  }

  private addPage(key: string, title: string, Component: React.ComponentType, sort: number) {
    this.app.pluginSettingsManager.add(`${MENU_KEY}.${key}`, {
      title: this.t(title),
      Component,
      aclSnippet: ACL_SNIPPET,
      sort,
    });
  }
}

export default PluginAppObservabilityClient;
