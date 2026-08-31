import { Plugin } from '@nocobase/client';
import React from 'react';
import { APIM_ACL, SETTINGS_KEY } from '../constants';

// Use React.lazy at module level (like plugin-ai-api does) instead of componentLoader.
// componentLoader triggers webpack code-splitting at render time which causes
// app shell re-renders that crash when VariablesContext is null in embedded block context.
const GuidePage = React.lazy(() => import('../client-v2/components/GuidePage'));
const SettingsPage = React.lazy(() => import('../client-v2/components/SettingsPage'));
const RoutesPage = React.lazy(() => import('../client-v2/components/RoutesPage'));
const PartnersPage = React.lazy(() => import('../client-v2/components/PartnersPage'));
const PartnerRolesPage = React.lazy(() => import('../client-v2/components/PartnerRolesPage'));
const RequestLogsPage = React.lazy(() => import('../client-v2/components/RequestLogsPage'));

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
      Component: GuidePage,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.settings`, {
      title: this.t('Runtime Settings'),
      aclSnippet: APIM_ACL,
      sort: -10,
      Component: SettingsPage,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.routes`, {
      title: this.t('Routes'),
      aclSnippet: APIM_ACL,
      sort: 1,
      Component: RoutesPage,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.partners`, {
      title: this.t('Partners'),
      aclSnippet: APIM_ACL,
      sort: 10,
      Component: PartnersPage,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.partner-roles`, {
      title: this.t('Partner Roles'),
      aclSnippet: APIM_ACL,
      sort: 15,
      Component: PartnerRolesPage,
    });

    this.app.pluginSettingsManager.add(`${SETTINGS_KEY}.logs`, {
      title: this.t('Request Logs'),
      aclSnippet: APIM_ACL,
      sort: 30,
      Component: RequestLogsPage,
    });
  }
}

export default PluginApiManagerClient;
