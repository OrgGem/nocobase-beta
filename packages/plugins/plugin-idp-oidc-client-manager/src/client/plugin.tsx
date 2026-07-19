import { Plugin } from '@nocobase/client';
import OidcClientsPage from './OidcClientsPage';

const SETTINGS_KEY = 'idp-oidc-client-manager';
const SETTINGS_ACL = 'pm.idp-oidc-client-manager.admin';

export class PluginIdpOidcClientManagerClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      icon: 'SafetyCertificateOutlined',
      title: this.t('OIDC applications'),
      Component: OidcClientsPage,
      aclSnippet: SETTINGS_ACL,
    });
  }

  async remove() {
    this.app.pluginSettingsManager.remove(SETTINGS_KEY);
  }
}

export default PluginIdpOidcClientManagerClient;
