import { Plugin } from '@nocobase/client-v2';

export class PluginRouterConfigurationClientV2 extends Plugin {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'router-configuration',
      title: this.t('Router Configuration'),
      icon: 'ApartmentOutlined',
      aclSnippet: 'pm.router-configuration',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'router-configuration',
      key: 'index',
      title: this.t('Router Configuration'),
      componentLoader: () => import('./RouterConfigManager').then((m) => ({ default: m.RouterConfigManager })),
    });
  }
}

export default PluginRouterConfigurationClientV2;
