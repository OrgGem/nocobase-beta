/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

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
      aclSnippet: 'pm.router-configuration',
    });
  }
}

export default PluginRouterConfigurationClientV2;
