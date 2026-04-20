/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import { ElasticsearchDataSource } from './data-source/ElasticsearchDataSource';

export class PluginDataSourceElasticsearchServer extends Plugin {
  async beforeLoad() {
    // Register 'elasticsearch' as a data source type
    (this as any).app.dataSourceManager.factory.register('elasticsearch', ElasticsearchDataSource);
  }

  async load() {
    // Define the test connection resource
    (this as any).app.resourcer.define({
      name: 'external-elasticsearch',
      actions: {
        async testConnection(ctx, next) {
          const payload = ctx.action?.params?.values || ctx.request.body || {};

          // The form sends { key, displayName, type, options: { nodes, ... } }
          // Extract the flat connection options from the nested structure if present.
          const connectionOptions = payload.options || payload;

          try {
            await ElasticsearchDataSource.testConnection(connectionOptions);
            ctx.body = { success: true };
          } catch (error) {
            ctx.throw(400, error.message);
          }
          await next();
        },
      },
      only: ['testConnection'],
    });

    // Handle collection destroy for elasticsearch data sources
    (this as any).app.resourcer.use(async (ctx, next) => {
      const { resourceName, actionName, associatedIndex: dataSourceKey } = ctx.action?.params || {};

      if (resourceName === 'dataSources.collections' && actionName === 'destroy' && dataSourceKey) {
        const dataSource = (this as any).app.dataSourceManager.dataSources.get(dataSourceKey);

        if (dataSource && dataSource instanceof ElasticsearchDataSource) {
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
            return;
          }
        }
      }

      await next();
    });

    // Register ACL snippet
    this.app.acl.registerSnippet({
      name: 'pm.data-source-manager.elasticsearch',
      actions: ['external-elasticsearch:*'],
    });

    // Allow test connection for logged-in users
    this.app.acl.allow('external-elasticsearch', 'testConnection', 'loggedIn');
  }
}

export default PluginDataSourceElasticsearchServer;
