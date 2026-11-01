/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Application, Plugin } from '@nocobase/client-v2';

export class PluginDocumentUnderstandingClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'document-understanding',
      title: this.t('Document Understanding'),
      icon: 'FileSearchOutlined',
      aclSnippet: `pm.${this.options.name || 'document-understanding'}`,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'document-understanding',
      key: 'index',
      title: this.t('Document Understanding'),
      componentLoader: () => import('./components/PluginSettings'),
      aclSnippet: `pm.${this.options.name || 'document-understanding'}`,
    });
  }
}

export default PluginDocumentUnderstandingClient;
