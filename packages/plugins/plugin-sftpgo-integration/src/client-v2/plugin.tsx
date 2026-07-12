import { Application, Plugin } from '@nocobase/client-v2';

const SETTINGS_KEY = 'sftpgo-integration';
const SETTINGS_ACL = 'pm.plugin-sftpgo-integration';

export class PluginSftpgoIntegrationClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('SFTPGo'),
      icon: 'CloudServerOutlined',
      aclSnippet: SETTINGS_ACL,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'connections',
      title: this.t('Connections'),
      aclSnippet: SETTINGS_ACL,
      sort: 1,
      componentLoader: () => import('./components/SftpgoConnections'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'users',
      title: this.t('Users'),
      aclSnippet: SETTINGS_ACL,
      sort: 10,
      hidden: true,
      componentLoader: () => import('./components/SftpgoUsers'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'folders',
      title: this.t('Folders'),
      aclSnippet: SETTINGS_ACL,
      sort: 20,
      hidden: true,
      componentLoader: () => import('./components/SftpgoFolders'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'apikeys',
      title: this.t('API Keys'),
      aclSnippet: SETTINGS_ACL,
      sort: 30,
      hidden: true,
      componentLoader: () => import('./components/SftpgoApiKeys'),
    });
  }
}

export default PluginSftpgoIntegrationClient;
