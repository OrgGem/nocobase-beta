/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';
import PluginDataSourceManagerClient from "@nocobase/plugin-data-source-manager";
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

