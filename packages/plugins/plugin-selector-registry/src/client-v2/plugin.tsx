import { Application, Plugin } from '@nocobase/client-v2';

import { SELECTOR_REGISTRY_SNIPPETS } from './permissions';

export class PluginSelectorRegistryClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'selector-registry',
      title: this.t('Selector Registry'),
      icon: 'AimOutlined',
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'selector-registry',
      key: 'dashboard',
      title: this.t('Dashboard'),
      componentLoader: () => import('./pages/DashboardPage'),
      sort: -1,
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'selector-registry',
      key: 'apps',
      title: this.t('Apps'),
      componentLoader: () => import('./pages/AppsPage'),
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'selector-registry',
      key: 'entries',
      title: this.t('Entries'),
      componentLoader: () => import('./pages/EntriesPage'),
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'selector-registry',
      key: 'resolve-logs',
      title: this.t('Resolve Logs'),
      componentLoader: () => import('./pages/ResolveLogsPage'),
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'selector-registry',
      key: 'feedbacks',
      title: this.t('Feedbacks'),
      componentLoader: () => import('./pages/FeedbacksPage'),
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'selector-registry',
      key: 'settings',
      title: this.t('Settings'),
      componentLoader: () => import('./pages/SettingsPage'),
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'selector-registry',
      key: 'api',
      title: this.t('API Reference'),
      componentLoader: () => import('./pages/ApiDocsPage'),
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });
  }
}

export default PluginSelectorRegistryClientV2;
