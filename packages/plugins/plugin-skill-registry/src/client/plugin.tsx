import { Plugin } from '@nocobase/client';

import CatalogPage from '../client-v2/pages/CatalogPage';
import SourcesPage from '../client-v2/pages/SourcesPage';
import SyncRunsPage from '../client-v2/pages/SyncRunsPage';
import VersionsPage from '../client-v2/pages/VersionsPage';
import SettingsPage from '../client-v2/pages/SettingsPage';
import { SKILL_REGISTRY_SNIPPETS } from '../client-v2/permissions';
import { withLegacySkillRegistryPermissions } from './LegacySkillRegistryPage';

const SETTINGS_KEY = 'skill-registry';
const SETTINGS_PAGES = [
  { key: 'index', title: 'Skills', Component: withLegacySkillRegistryPermissions(CatalogPage), sort: -1 },
  { key: 'sources', title: 'Sources', Component: withLegacySkillRegistryPermissions(SourcesPage) },
  { key: 'runs', title: 'Sync runs', Component: withLegacySkillRegistryPermissions(SyncRunsPage) },
  { key: 'versions', title: 'Version audit', Component: withLegacySkillRegistryPermissions(VersionsPage) },
  { key: 'settings', title: 'Settings', Component: withLegacySkillRegistryPermissions(SettingsPage) },
] as const;

export class PluginSkillRegistryClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('Skill Registry'),
      icon: 'CloudServerOutlined',
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });

    for (const page of SETTINGS_PAGES) {
      this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.${page.key}`, {
        title: this.t(page.title),
        Component: page.Component,
        sort: 'sort' in page ? page.sort : undefined,
        aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
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

export default PluginSkillRegistryClient;
