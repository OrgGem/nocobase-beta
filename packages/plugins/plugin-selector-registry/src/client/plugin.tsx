import { Plugin } from '@nocobase/client';

import ApiDocsPage from '../client-v2/pages/ApiDocsPage';
import AppsPage from '../client-v2/pages/AppsPage';
import DashboardPage from '../client-v2/pages/DashboardPage';
import EntriesPage from '../client-v2/pages/EntriesPage';
import FeedbacksPage from '../client-v2/pages/FeedbacksPage';
import ResolveLogsPage from '../client-v2/pages/ResolveLogsPage';
import SettingsPage from '../client-v2/pages/SettingsPage';
import { SELECTOR_REGISTRY_SNIPPETS } from '../client-v2/permissions';
import { withLegacySelectorRegistryPermissions } from './LegacySelectorRegistryPage';

const SETTINGS_KEY = 'selector-registry';
const SETTINGS_PAGES = [
  { key: 'dashboard', title: 'Dashboard', Component: withLegacySelectorRegistryPermissions(DashboardPage), sort: -1 },
  { key: 'apps', title: 'Apps', Component: withLegacySelectorRegistryPermissions(AppsPage) },
  { key: 'entries', title: 'Entries', Component: withLegacySelectorRegistryPermissions(EntriesPage) },
  { key: 'resolve-logs', title: 'Resolve Logs', Component: withLegacySelectorRegistryPermissions(ResolveLogsPage) },
  { key: 'feedbacks', title: 'Feedbacks', Component: withLegacySelectorRegistryPermissions(FeedbacksPage) },
  { key: 'settings', title: 'Settings', Component: withLegacySelectorRegistryPermissions(SettingsPage) },
  { key: 'api', title: 'API Reference', Component: withLegacySelectorRegistryPermissions(ApiDocsPage) },
] as const;

export class PluginSelectorRegistryClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('Selector Registry'),
      icon: 'AimOutlined',
      aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
    });

    for (const page of SETTINGS_PAGES) {
      this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.${page.key}`, {
        title: this.t(page.title),
        Component: page.Component,
        sort: 'sort' in page ? page.sort : undefined,
        aclSnippet: SELECTOR_REGISTRY_SNIPPETS.read,
      });
    }
  }

  async remove() {
    for (const page of SETTINGS_PAGES) {
      this.app.pluginSettingsManager.remove(`${SETTINGS_KEY}.${page.key}`);
    }
    this.app.pluginSettingsManager.remove(SETTINGS_KEY);
  }
}

export default PluginSelectorRegistryClient;
