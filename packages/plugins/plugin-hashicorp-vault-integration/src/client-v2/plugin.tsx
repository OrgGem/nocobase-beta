import { Application, Plugin } from '@nocobase/client-v2';
import { registerVaultProperty } from './registerVaultProperty';

const SETTINGS_KEY = 'hashicorp-vault';
const SETTINGS_ACL = 'pm.plugin-hashicorp-vault-integration';

export class PluginHashicorpVaultIntegrationClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('HashiCorp Vault'),
      icon: 'SafetyOutlined',
      aclSnippet: SETTINGS_ACL,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'connections',
      title: this.t('Connections'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('./components/VaultConnections'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'mappings',
      title: this.t('Secret Mappings'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('./components/VaultSecretMappings'),
    });

    registerVaultProperty(this.flowEngine.context, this.app.apiClient, (key) => this.t(key));
  }
}

export default PluginHashicorpVaultIntegrationClient;
