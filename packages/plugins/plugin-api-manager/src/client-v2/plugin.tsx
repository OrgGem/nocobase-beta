import { Application, Plugin } from '@nocobase/client-v2';
import { APIM_ACL, SETTINGS_KEY } from '../constants';

export class PluginApiManagerClient extends Plugin<Record<string, never>, Application> {
  async load() {
    this.pluginSettingsManager.addMenuItem({
      key: SETTINGS_KEY,
      title: this.t('API Manager'),
      icon: 'ApiOutlined',
      aclSnippet: APIM_ACL,
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'routes',
      title: this.t('Routes'),
      aclSnippet: APIM_ACL,
      sort: 1,
      componentLoader: () => import('./components/RoutesPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'partners',
      title: this.t('Partners'),
      aclSnippet: APIM_ACL,
      sort: 10,
      componentLoader: () => import('./components/PartnersPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'keys',
      title: this.t('API Keys'),
      aclSnippet: APIM_ACL,
      sort: 20,
      componentLoader: () => import('./components/ApiKeysPage'),
    });

    this.pluginSettingsManager.addPageTabItem({
      menuKey: SETTINGS_KEY,
      key: 'logs',
      title: this.t('Request Logs'),
      aclSnippet: APIM_ACL,
      sort: 30,
      componentLoader: () => import('./components/RequestLogsPage'),
    });
  }
}

export default PluginApiManagerClient;
