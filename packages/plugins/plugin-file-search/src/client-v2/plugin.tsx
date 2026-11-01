/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Application, Plugin } from '@nocobase/client-v2';

export class PluginFileSearchClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'plugin-file-search',
      title: this.t('File Search'),
      icon: 'FileSearchOutlined',
      aclSnippet: `pm.${this.options.name || 'plugin-file-search'}.manage`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'plugin-file-search',
      aclSnippet: `pm.${this.options.name || 'plugin-file-search'}.manage`,
      key: 'index',
      title: this.t('File Search'),
      componentLoader: () => import('./components/SettingsPage').then((module) => ({ default: module.SettingsPage })),
    });
  }
}

export default PluginFileSearchClientV2;
