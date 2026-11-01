/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';

export class PluginDocumentParserClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'document-parser',
      title: this.t('Document Parser'),
      icon: 'FileTextOutlined',
      aclSnippet: 'pm.document-parser.settings',
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'document-parser',
      aclSnippet: 'pm.document-parser.settings',
      key: 'index',
      title: this.t('Document Parser'),
      componentLoader: () => import('./pages/DocumentParserSettingsPage'),
    });
  }
}

export default PluginDocumentParserClient;
