import { Application, Plugin } from '@nocobase/client-v2';

import { SKILL_REGISTRY_SNIPPETS } from './permissions';

export class PluginSkillRegistryClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'skill-registry',
      title: this.t('Skill Registry'),
      icon: 'CloudServerOutlined',
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'skill-registry',
      key: 'index',
      title: this.t('Skills'),
      componentLoader: () => import('./pages/CatalogPage'),
      sort: -1,
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'skill-registry',
      key: 'markdown-skills',
      title: this.t('Markdown skills'),
      componentLoader: () => import('./pages/MarkdownSkillsPage'),
      aclSnippet: SKILL_REGISTRY_SNIPPETS.markdown,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'skill-registry',
      key: 'sources',
      title: this.t('Sources'),
      componentLoader: () => import('./pages/SourcesPage'),
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'skill-registry',
      key: 'runs',
      title: this.t('Sync runs'),
      componentLoader: () => import('./pages/SyncRunsPage'),
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'skill-registry',
      key: 'versions',
      title: this.t('Version audit'),
      componentLoader: () => import('./pages/VersionsPage'),
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'skill-registry',
      key: 'settings',
      title: this.t('Settings'),
      componentLoader: () => import('./pages/SettingsPage'),
      aclSnippet: SKILL_REGISTRY_SNIPPETS.read,
    });
  }
}

export default PluginSkillRegistryClientV2;
