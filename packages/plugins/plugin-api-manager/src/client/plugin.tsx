import { Plugin } from '@nocobase/client';
import { APIM_ACL, SETTINGS_KEY } from '../constants';

export class PluginApiManagerClient extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(SETTINGS_KEY, {
      title: this.t('API Manager'),
      icon: 'ApiOutlined',
      aclSnippet: APIM_ACL,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.guide`, {
      title: this.t('Guide'),
      aclSnippet: APIM_ACL,
      sort: 0,
      componentLoader: () => import('../client-v2/components/GuidePage'),
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.settings`, {
      title: this.t('Runtime Settings'),
      aclSnippet: APIM_ACL,
      sort: -10,
      componentLoader: () => import('../client-v2/components/SettingsPage'),
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

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.partner-roles`, {
      title: this.t('Partner Roles'),
      aclSnippet: APIM_ACL,
      sort: 15,
      componentLoader: () => import('../client-v2/components/PartnerRolesPage'),
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
