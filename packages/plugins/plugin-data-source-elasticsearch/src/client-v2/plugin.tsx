import { Application, Plugin } from '@nocobase/client-v2';
import PluginDataSourceManagerClientV2 from '@nocobase/plugin-data-source-manager/client-v2';
import React from 'react';

export class PluginDataSourceElasticsearchClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClientV2);
    if (manager) {
      manager.registerType('elasticsearch', {
        label: 'Elasticsearch',
        SettingsForm: React.lazy(() => import('./ElasticsearchSettingsForm')),
        disableTestConnection: false,
        disableAddFields: true,
        normalizeValues: (values) => {
          const options = values.options || {};
          return {
            ...values,
            options: {
              ...options,
              addAllCollections: options.addAllCollections !== false,
            },
          };
        },
      });
    }
  }
}

export default PluginDataSourceElasticsearchClient;
