import { Plugin } from '@nocobase/client';

// The v1 and v2 PluginSettingsManagers are separate, decoupled registries.
// `/admin/settings/` (and the ACL role editor's "Plugin settings" list) are
// rendered from this v1 registry, so the settings menu must be registered
// here too, in addition to ../client-v2/plugin.tsx which drives the v2 shell.
const SETTINGS_KEY = 'sftpgo-integration';
const SETTINGS_ACL = 'pm.plugin-sftpgo-integration';

export class PluginSftpgoIntegrationClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('SFTPGo'),
      icon: 'CloudServerOutlined',
      aclSnippet: SETTINGS_ACL,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.connections`, {
      title: this.t('Connections'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/SftpgoConnections'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.users`, {
      title: this.t('Users'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/SftpgoUsers'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.folders`, {
      title: this.t('Folders'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/SftpgoFolders'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.apikeys`, {
      title: this.t('API Keys'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/SftpgoApiKeys'),
    });
  }
}

export default PluginSftpgoIntegrationClient;
