/**
 * Plugin Data Source MSSQL V2 — Client (V1)
 */

import { Plugin } from '@nocobase/client';
import PluginDataSourceManagerClient from '@nocobase/plugin-data-source-manager/client';
import { MssqlV2ConfigForm } from './components/MssqlV2ConfigForm';

export class PluginDataSourceMssqlV2Client extends Plugin {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClient);

    manager.registerType('mssql-v2', {
      name: 'mssql-v2',
      label: 'External MSSQL V2',
      icon: 'DatabaseOutlined',
      color: 'blue',
      DataSourceSettingsForm: MssqlV2ConfigForm,
      disableTestConnection: false,
      disableAddFields: false,
      allowCollectionDeletion: true,
    });
  }
}

export default PluginDataSourceMssqlV2Client;
