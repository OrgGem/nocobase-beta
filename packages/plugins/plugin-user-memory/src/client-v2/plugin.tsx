import { Plugin, Application } from '@nocobase/client-v2';

export class PluginUserMemoryClient extends Plugin<any, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-user-memory',
      title: this.t('User Memory'),
      icon: 'BulbOutlined',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-user-memory',
      key: 'index',
      title: this.t('User Memory'),
      componentLoader: () => import('../client/components/MemorySettingsPage'),
    });
  }
}

export default PluginUserMemoryClient;
