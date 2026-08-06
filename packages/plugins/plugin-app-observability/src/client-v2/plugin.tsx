import { Application, Plugin } from '@nocobase/client-v2';
import type { ComponentType } from 'react';

const MENU_KEY = 'plugin-app-observability';
const ACL_SNIPPET = 'pm.plugin-app-observability';
export class PluginAppObservabilityClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: MENU_KEY,
      title: this.t('App observability'),
      icon: 'FundProjectionScreenOutlined',
      aclSnippet: ACL_SNIPPET,
    });
    this.addTab('index', 'Overview', () => import('./pages/OverviewPage'));
    this.addTab('nodes', 'Nodes', () => import('./pages/NodesPage'));
    this.addTab('services', 'Services', () => import('./pages/ServicesPage'));
    this.addTab('capacity', 'Capacity', () => import('./pages/CapacityPage'));
    this.addTab('settings', 'Settings', () => import('./pages/SettingsPage'));
  }
  private addTab(key: string, title: string, componentLoader: () => Promise<{ default: ComponentType }>) {
    this.pluginSettingsManager.addPageTabItem({
      menuKey: MENU_KEY,
      key,
      title: this.t(title),
      aclSnippet: ACL_SNIPPET,
      componentLoader,
    });
  }
}
export default PluginAppObservabilityClient;
