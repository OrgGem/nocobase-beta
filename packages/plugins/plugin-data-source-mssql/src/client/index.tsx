/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';
import PluginDataSourceManagerClient from '@nocobase/plugin-data-source-manager/client';
import { MssqlConfigForm } from './components/MssqlConfigForm';
import { MssqlDeleteCollection } from './components/MssqlDeleteCollection';

export class PluginDataSourceMssqlClient extends Plugin {
  async load() {
    console.log('[MSSQL Plugin] Client loading...');
    const manager = this.app.pm.get(PluginDataSourceManagerClient);

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
