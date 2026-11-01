/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin, Application } from '@nocobase/client-v2';
import PluginDataSourceManagerClientV2 from '@nocobase/plugin-data-source-manager/client-v2';
import React from 'react';

export class PluginDataSourceMssqlClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const manager = this.app.pm.get(PluginDataSourceManagerClientV2);
    if (manager) {
      manager.registerType('mssql', {
        label: String(this.t('External MSSQL')),
        SettingsForm: React.lazy(() =>
          import('./components/MssqlConfigForm').then((m) => ({ default: m.MssqlConfigForm })),
        ),
        disableTestConnection: false,
        disableAddFields: false,
        normalizeValues: (values) => ({
          ...values,
          options: {
            ...values.options,
            addAllCollections: values.options?.addAllCollections ?? values.addAllCollections ?? true,
          },
        }),
      });
    }
  }
}

export default PluginDataSourceMssqlClient;
