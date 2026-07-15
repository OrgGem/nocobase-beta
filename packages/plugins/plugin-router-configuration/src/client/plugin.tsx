import { lazy, Plugin } from '@nocobase/client';

const { RouterConfigManager } = lazy(() => import('./RouterConfigManager'), 'RouterConfigManager');

export class PluginRouterConfigurationClient extends Plugin {
  async load() {
    this.pluginSettingsManager.add('router-configuration', {
      title: this.t('Router Configuration'),
      icon: 'ApartmentOutlined',
      Component: RouterConfigManager,
      aclSnippet: 'pm.router-configuration',
    });
  }
}

export default PluginRouterConfigurationClient;
