import { Plugin, Application } from '@nocobase/client-v2';
import PluginDataSourceManagerClientV2 from '@nocobase/plugin-data-source-manager/client-v2';
import React from 'react';

export class PluginDataSourceMssqlV2Client extends Plugin<Record<string, never>, Application> {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClientV2);
    if (manager) {
      manager.registerType('mssql-v2', {
        label: 'External MSSQL V2',
        SettingsForm: React.lazy(() =>
          import('../client/components/MssqlV2ConfigForm').then((m) => ({ default: m.MssqlV2ConfigForm })),
        ),
        disableTestConnection: false,
        disableAddFields: false,
        allowCollectionDeletion: true,
        // External datasource — no raw SQL or query capabilities exposed
        capabilities: {
          query: false,
          runSQL: false,
        },
        // Normalize form values before submit/test
        normalizeValues: (values) => {
          const options = values.options || {};
          return {
            ...values,
            options: {
              ...options,
              port: options.port ? Number(options.port) : 1433,
              encrypt: options.encrypt ?? false,
              trustServerCertificate: options.trustServerCertificate ?? false,
              addAllCollections: options.addAllCollections !== false,
            },
          };
        },
      });
    }
  }
}

export default PluginDataSourceMssqlV2Client;
