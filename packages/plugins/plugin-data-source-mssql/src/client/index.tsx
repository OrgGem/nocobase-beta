// SPDX-License-Identifier: Apache-2.0

import { Plugin } from '@nocobase/client';
import PluginDataSourceManagerClient from '@nocobase/plugin-data-source-manager/client';
import { MssqlConfigForm } from './components/MssqlConfigForm';
import { MssqlDeleteCollection } from './components/MssqlDeleteCollection';

export class PluginDataSourceMssqlClient extends Plugin {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClient);
    if (!manager) {
      return;
    }

    manager.registerType('mssql', {
      name: 'mssql',
      label: 'External MSSQL',
      icon: 'DatabaseOutlined',
      color: 'blue',
      DataSourceSettingsForm: MssqlConfigForm,
      DeleteCollection: MssqlDeleteCollection,
      disableTestConnection: false,
      disableAddFields: false,
      allowCollectionDeletion: true,
    });
  }
}

export default PluginDataSourceMssqlClient;
