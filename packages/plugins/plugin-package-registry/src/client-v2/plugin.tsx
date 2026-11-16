// SPDX-License-Identifier: Apache-2.0

import { Plugin, Application } from '@nocobase/client-v2';

export class PluginPackageRegistryClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-package-registry',
      title: this.t('Package Registries'),
      icon: 'ApiOutlined',
      aclSnippet: `pm.${this.options.name || 'plugin-package-registry'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-package-registry',
      aclSnippet: `pm.${this.options.name || 'plugin-package-registry'}`,
      key: 'index',
      title: this.t('Package Registries'),

      componentLoader: () =>
        import('../client/PackageRegistriesSettings').then((m) => ({ default: m.PackageRegistriesSettings })),
    });
  }
}

export default PluginPackageRegistryClient;
