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

    /**
     * Middleware: load Elasticsearch tables into collections during create/update.
     *
     * The core framework's loadDataSourceTablesIntoCollections middleware only
     * handles DatabaseDataSource subclasses (Sequelize-based). Since
     * ElasticsearchDataSource extends plain DataSource (no Sequelize), we handle
     * collection loading ourselves with the same pattern.
     *
     * This runs BEFORE the core middleware and intercepts Elasticsearch data
     * source create/update requests.
     */
    (this as any).app.resourceManager.use(async (ctx, next) => {
      const { actionName, resourceName, params } = ctx.action || {};

      if (resourceName === 'dataSources' && (actionName === 'create' || actionName === 'update')) {
        const { options, type, collections, key } = params?.values || {};

        // Only intercept elasticsearch type data sources
        const isElasticsearch =
          type === 'elasticsearch' ||
          (actionName === 'update' && await this.isElasticsearchDataSource(ctx, params?.filterByTk));

        if (isElasticsearch && options) {
          try {
            // Create a temporary data source to introspect
            const dsName = actionName === 'update' ? params.filterByTk : key;
            const tempDs = (this as any).app.dataSourceManager.factory.create('elasticsearch', {
              name: dsName,
              ...options,
            });
            tempDs.setLogger(ctx.logger || this.app.logger);

            if (options.addAllCollections) {
              // readTables is used to check count limits
              const allIndices = await tempDs.readTables();
              const maxCollections = 500; // same as core ALLOW_MAX_COLLECTIONS_COUNT
              if (allIndices.length > maxCollections) {
                await tempDs.close();
                throw new Error(
                  `The number of collections exceeds the limit of ${maxCollections}. ` +
                  `Please remove some collections before adding new ones.`,
                );
              }
              // Don't load individually — all indices will be loaded during load()
            } else if (collections && collections.length > 0) {
              // Load only selected collections
              await tempDs.loadTables(ctx, collections);
            }

            // Clean up temp client
            await tempDs.close();

            // Remove collections from the payload so the core framework
            // doesn't try to process them again
            if (collections) {
              delete ctx.action.params.values.collections;
            }
          } catch (error) {
            this.app.logger.error('[Elasticsearch] Failed to process collections during create/update:', error);
            throw error;
          }
        }
      }

      await next();
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

  /**
   * Check if an existing data source is of type 'elasticsearch'.
   */
  private async isElasticsearchDataSource(ctx: any, filterByTk: string): Promise<boolean> {
    if (!filterByTk) return false;
    try {
      const dataSourcesRepo = ctx.db.getRepository('dataSources');
      const model = await dataSourcesRepo.findByTargetKey(filterByTk);
      return model?.get('type') === 'elasticsearch';
    } catch {
      return false;
    }
  }
}

export default PluginDataSourceElasticsearchServer;
