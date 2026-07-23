import { Application, Plugin } from '@nocobase/client-v2';

const key = 'microsoft-graph-gateway';
const acl = 'pm.microsoft-graph-gateway';

export default class PluginMicrosoftGraphGatewayClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key,
      title: this.t('Microsoft Graph Gateway'),
      icon: 'CloudOutlined',
      aclSnippet: acl,
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: key,
      key: 'index',
      title: this.t('Configuration'),
      aclSnippet: acl,
      componentLoader: () => import('./pages/ConfigurationPage'),
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: key,
      key: 'api-keys',
      title: this.t('API Keys'),
      aclSnippet: acl,
      componentLoader: () => import('./pages/ApiKeysPage'),
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: key,
      key: 'operations',
      title: this.t('Queue & Audit'),
      aclSnippet: acl,
      componentLoader: () => import('./pages/OperationsPage'),
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: key,
      key: 'api-docs',
      title: this.t('API Documentation'),
      aclSnippet: acl,
      componentLoader: () => import('./pages/ApiDocsPage'),
    });
  }
}
