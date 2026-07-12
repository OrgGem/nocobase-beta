import { Application, Plugin } from '@nocobase/client-v2';

export class PluginFileSearchClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-file-search',
      title: this.t('File Search'),
      icon: 'FileSearchOutlined',
      aclSnippet: 'pm.plugin-file-search.manage',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-file-search',
      key: 'index',
      title: this.t('File Search'),
      componentLoader: () => import('./components/SettingsPage').then((module) => ({ default: module.SettingsPage })),
    });
  }
}

export default PluginFileSearchClientV2;
