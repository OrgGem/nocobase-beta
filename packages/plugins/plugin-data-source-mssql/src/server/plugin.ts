/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { MssqlExternalDataSource } from './data-source/MssqlExternalDataSource';
import { Database } from '@nocobase/database';
import { MssqlDialect } from './dialects/mssql-dialect';

export class PluginDataSourceMssqlServer extends Plugin {
  async beforeLoad() {
    Database.registerDialect(MssqlDialect);
    (this as any).app.dataSourceManager.factory.register('mssql', MssqlExternalDataSource);
  }

  // No custom load() needed:
  // - Test connection: core `dataSources:testConnection` dispatches to
  //   MssqlExternalDataSource.testConnection() via the factory automatically.
  // - Collection destroy: core `dataSourcesCollections.afterDestroy` hook
  //   handles in-memory cleanup + cluster sync for all external data sources.
  // - CRUD: core `plugin-data-source-manager` provides full lifecycle management.
}

export default PluginDataSourceMssqlServer;

