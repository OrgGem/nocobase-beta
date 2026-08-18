import { Plugin } from '@nocobase/client';
import { APIM_ACL, SETTINGS_KEY } from '../constants';

export class PluginApiManagerClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('API Manager'),
      icon: 'ApiOutlined',
      aclSnippet: APIM_ACL,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.routes`, {
      title: this.t('Routes'),
      aclSnippet: APIM_ACL,
      sort: 1,
      componentLoader: () => import('../client-v2/components/RoutesPage'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.partners`, {
      title: this.t('Partners'),
      aclSnippet: APIM_ACL,
      sort: 10,
      componentLoader: () => import('../client-v2/components/PartnersPage'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.keys`, {
      title: this.t('API Keys'),
      aclSnippet: APIM_ACL,
      sort: 20,
      componentLoader: () => import('../client-v2/components/ApiKeysPage'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.logs`, {
      title: this.t('Request Logs'),
      aclSnippet: APIM_ACL,
      sort: 30,
      componentLoader: () => import('../client-v2/components/RequestLogsPage'),
    });
  }
}

export default PluginApiManagerClient;
