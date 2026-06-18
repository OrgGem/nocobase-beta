import { Plugin, Application } from '@nocobase/client-v2';
import PluginDataSourceManagerClientV2 from '@nocobase/plugin-data-source-manager/client-v2';
import React from 'react';

export class PluginDataSourceMssqlClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClientV2);
    if (manager) {
      manager.registerType('mssql', {
        label: 'External MSSQL',
        SettingsForm: React.lazy(() => import('../client/components/MssqlConfigForm').then(m => ({ default: m.MssqlConfigForm }))),
        disableTestConnection: false,
        disableAddFields: false,
      });
    }
  }
}

export default PluginDataSourceMssqlClient;
