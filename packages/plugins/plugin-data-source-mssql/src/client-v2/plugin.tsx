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
import { MssqlDeleteCollection } from './MssqlDeleteCollection';

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
        allowCollectionDeletion: true,
        DeleteCollection: MssqlDeleteCollection,
        disableAddFields: false,
        normalizeValues: (values) => {
          const { __mssqlPreserveLegacySelection, ...normalized } = values;
          const addAllCollections = values.options?.addAllCollections ?? values.addAllCollections ?? true;
          if (__mssqlPreserveLegacySelection && addAllCollections === false) {
            delete normalized.collections;
          }
          return {
            ...normalized,
            options: {
              ...values.options,
              addAllCollections,
            },
          };
        },
      });
    }
  }
}

export default PluginDataSourceMssqlClient;
