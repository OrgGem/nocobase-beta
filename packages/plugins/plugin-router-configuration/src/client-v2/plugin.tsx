// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client-v2';
import { installFriendlyPathAliases } from './pathAliasRuntime';

export class PluginRouterConfigurationClientV2 extends Plugin {
  async load() {
    installFriendlyPathAliases(this.app);

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
      aclSnippet: 'pm.router-configuration',
    });
  }
}

export default PluginRouterConfigurationClientV2;
