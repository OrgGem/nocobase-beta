import { Plugin, Application } from '@nocobase/client-v2';
import React from 'react';

export class PluginPackageRegistryClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-package-registry',
      title: this.t('Package Registries'),
      icon: 'ApiOutlined',
      
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-package-registry',
      key: 'index',
      title: this.t('Package Registries'),
      
      componentLoader: () => import('../client/PackageRegistriesSettings').then(m => ({ default: m.PackageRegistriesSettings })),
    });

  }
}

export default PluginPackageRegistryClient;
