import { Plugin } from '@nocobase/client';
import React from 'react';

const key = 'microsoft-graph-gateway';
const acl = 'pm.microsoft-graph-gateway';
const pages = [
  { key: 'index', title: 'Configuration', loader: () => import('../client-v2/pages/ConfigurationPage') },
  { key: 'api-keys', title: 'API Keys', loader: () => import('../client-v2/pages/ApiKeysPage') },
  { key: 'operations', title: 'Queue & Audit', loader: () => import('../client-v2/pages/OperationsPage') },
  { key: 'api-docs', title: 'API Documentation', loader: () => import('../client-v2/pages/ApiDocsPage') },
];

export default class PluginMicrosoftGraphGatewayClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(key, {
      title: this.t('Microsoft Graph Gateway'),
      icon: 'CloudOutlined',
      aclSnippet: acl,
    });
    pages.forEach((page, index) => {
      this.app.pluginSettingsManager.add(`${key}.${page.key}`, {
        title: this.t(page.title),
        Component: React.lazy(page.loader),
        aclSnippet: acl,
        sort: index + 1,
      });
    });
  }

  async remove() {
    pages.forEach((page) => this.app.pluginSettingsManager.remove(`${key}.${page.key}`));
    this.app.pluginSettingsManager.remove(key);
  }
}
