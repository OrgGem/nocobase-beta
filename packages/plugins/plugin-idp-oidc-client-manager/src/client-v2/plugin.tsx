import { Application, Plugin } from '@nocobase/client-v2';

const SETTINGS_KEY = 'idp-oidc-client-manager';
const SETTINGS_ACL = 'pm.idp-oidc-client-manager.admin';

export class PluginIdpOidcClientManagerClientV2 extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('OIDC applications'),
      icon: 'SafetyCertificateOutlined',
      aclSnippet: SETTINGS_ACL,
    });
    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'applications',
      title: this.t('Applications'),
      aclSnippet: SETTINGS_ACL,
      componentLoader: () => import('./OidcClientsPage'),
    });
  }
}

export default PluginIdpOidcClientManagerClientV2;
