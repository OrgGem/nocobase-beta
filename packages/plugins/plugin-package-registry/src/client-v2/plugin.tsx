/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
