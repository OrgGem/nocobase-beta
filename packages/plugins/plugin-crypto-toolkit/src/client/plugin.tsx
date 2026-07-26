import { Plugin } from '@nocobase/client';

const SETTINGS_KEY = 'crypto-toolkit';
const SETTINGS_ACL = 'pm.plugin-crypto-toolkit';

export class PluginCryptoToolkitClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('Crypto Toolkit'),
      icon: 'SafetyOutlined',
      aclSnippet: SETTINGS_ACL,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.keys`, {
      title: this.t('Keys'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/KeysPage'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.operations`, {
      title: this.t('Operations'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/OperationsPage'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.certs`, {
      title: this.t('Certificates'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('../client-v2/components/CertsPage'),
    });
  }
}

export default PluginCryptoToolkitClient;
