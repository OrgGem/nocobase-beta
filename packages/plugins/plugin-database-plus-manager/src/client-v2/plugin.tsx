import React from 'react';
import { Application, Plugin } from '@nocobase/client-v2';

const PAGINATION_ACL_SNIPPET = 'pm.plugin-database-plus-manager';

export class PluginDatabasePlusManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: 'database-plus-manager',
      icon: 'DatabaseOutlined',
      title: this.t('Database Plus Manager'),
      aclSnippet: PAGINATION_ACL_SNIPPET,
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: 'database-plus-manager',
      key: 'index',
      title: this.t('Database Plus'),
      aclSnippet: PAGINATION_ACL_SNIPPET,
      componentLoader: () => import('./pages/DatabasePlusPage'),
    });
  }
}

export default PluginDatabasePlusManagerClient;
