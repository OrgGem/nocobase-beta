// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client';
import React from 'react';

const PAGINATION_ACL_SNIPPET = 'pm.plugin-database-plus-manager';

// Lazy load settings page
const DatabasePlusPage = React.lazy(() => import('../client-v2/pages/DatabasePlusPage'));

export class PluginDatabasePlusManagerClient extends Plugin {
  async load() {
    // Use v1-compatible pluginSettingsManager.add() instead of v2 addMenuItem/addPageTabItem
    this.app.pluginSettingsManager.add('plugin-database-plus-manager', {
      icon: 'DatabaseOutlined',
      title: this.t('Database Plus Manager'),
      aclSnippet: PAGINATION_ACL_SNIPPET,
    });

    this.app.pluginSettingsManager.add('plugin-database-plus-manager.index', {
      title: this.t('Database Plus'),
      Component: () => (
        <React.Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading...</div>}>
          <DatabasePlusPage />
        </React.Suspense>
      ),
      aclSnippet: PAGINATION_ACL_SNIPPET,
    });
  }
}

export default PluginDatabasePlusManagerClient;
