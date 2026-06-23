import { Plugin, Application } from '@nocobase/client-v2';

const SETTINGS_KEY = 'plugin-user-memory';
const SETTINGS_ACL = 'pm.user-memory.admin';

export class PluginUserMemoryClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('User Memory'),
      icon: 'BulbOutlined',
      aclSnippet: SETTINGS_ACL,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'index',
      title: this.t('User Memory'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client/components/MemorySettingsPage'),
    });
  }
}

export default PluginUserMemoryClient;
