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
import { ExternalMssqlController } from './controllers/ExternalMssqlController';
import { Database } from '@nocobase/database';
import { MssqlDialect } from './dialects/mssql-dialect';

export class PluginDataSourceMssqlServer extends Plugin {
  async beforeLoad() {
    Database.registerDialect(MssqlDialect);
    (this as any).app.dataSourceManager.factory.register('mssql', MssqlExternalDataSource);
  }

  async load() {
    const controller = new ExternalMssqlController();

    (this as any).app.resourcer.define({
      name: 'external-mssql',
      actions: {
        async testConnection(ctx, next) {
          await controller.testConnection(ctx);
          await next();
        },
      },
      only: ['testConnection'],
    });

    // Handle collection destroy for mssql data sources.
    // This is needed because external data sources don't use the main DB's
    // collection destroy pipeline — we need to clean up both metadata and in-memory state.
    (this as any).app.resourcer.use(async (ctx, next) => {
      const { resourceName, actionName, associatedIndex: dataSourceKey } = ctx.action?.params || {};

      if (resourceName === 'dataSources.collections' && actionName === 'destroy' && dataSourceKey) {
        const dataSource = (this as any).app.dataSourceManager.dataSources.get(dataSourceKey);

        if (dataSource && dataSource instanceof MssqlExternalDataSource) {
          const { filterByTk: collectionName } = ctx.action.params;

          if (collectionName) {
            // Remove from dataSourcesCollections table (metadata)
            await ctx.db.getRepository('dataSourcesCollections').destroy({
              filter: {
                name: collectionName,
                dataSourceKey,
              },
            });

            // Remove associated fields from metadata
            await ctx.db.getRepository('dataSourcesFields').destroy({
              filter: {
                collectionName,
                dataSourceKey,
              },
            });

            // Remove from in-memory collection manager
            dataSource.collectionManager.removeCollection(collectionName);

            ctx.body = { success: true };
            return; // Don't call next() - we handled the action
          }
        }
      }

      await next();
    });
  }
}

export default PluginDataSourceMssqlServer;
