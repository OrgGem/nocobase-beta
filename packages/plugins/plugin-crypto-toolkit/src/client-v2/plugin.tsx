import { Application, Plugin } from '@nocobase/client-v2';

const SETTINGS_KEY = 'crypto-toolkit';
const SETTINGS_ACL = 'pm.plugin-crypto-toolkit';

export class PluginCryptoToolkitClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('Crypto Toolkit'),
      icon: 'SafetyOutlined',
      aclSnippet: SETTINGS_ACL,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'keys',
      title: this.t('Keys'),
      aclSnippet: SETTINGS_ACL,
      sort: 1,
      componentLoader: () => import('./components/KeysPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'operations',
      title: this.t('Operations'),
      aclSnippet: SETTINGS_ACL,
      sort: 10,
      componentLoader: () => import('./components/OperationsPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'certs',
      title: this.t('Certificates'),
      aclSnippet: SETTINGS_ACL,
      sort: 20,
      componentLoader: () => import('./components/CertsPage'),
    });
  }
}

export default PluginCryptoToolkitClient;
