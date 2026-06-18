import { Plugin, Application } from '@nocobase/client-v2';
import PluginDataSourceManagerClientV2 from '@nocobase/plugin-data-source-manager/client-v2';
import React from 'react';

export class PluginDataSourceElasticsearchClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClientV2);
    if (manager) {
      manager.registerType('elasticsearch', {
        label: 'Elasticsearch',
        SettingsForm: React.lazy(() => import('../client/components/ElasticsearchConfigForm').then(m => ({ default: m.ElasticsearchConfigForm }))),
        disableTestConnection: false,
        disableAddFields: true,
      });
    }
  }
}

export default PluginDataSourceElasticsearchClient;
