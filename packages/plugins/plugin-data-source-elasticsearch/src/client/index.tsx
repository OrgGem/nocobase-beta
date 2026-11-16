// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client';
import PluginDataSourceManagerClient from '@nocobase/plugin-data-source-manager';
import { ElasticsearchConfigForm } from './components/ElasticsearchConfigForm';
import { ElasticsearchDeleteCollection } from './components/ElasticsearchDeleteCollection';

export class PluginDataSourceElasticsearchClient extends Plugin {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClient);

    manager.registerType('elasticsearch', {
      name: 'elasticsearch',
      label: 'Elasticsearch',
      icon: 'SearchOutlined',
      color: 'gold',
      DataSourceSettingsForm: ElasticsearchConfigForm,
      DeleteCollection: ElasticsearchDeleteCollection,
      disableTestConnection: false,
      disableAddFields: true,
      allowCollectionDeletion: true,
    });
  }
}

export default PluginDataSourceElasticsearchClient;
