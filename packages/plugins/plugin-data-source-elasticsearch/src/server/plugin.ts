/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/server';
import path from 'path';
import {
  ElasticsearchDataSource,
  getElasticsearchConnectionOptions,
  normalizeElasticsearchCollectionNames,
} from './data-source/ElasticsearchDataSource';
import type { ElasticsearchDataSourceOptions } from './data-source/ElasticsearchDataSource';

const MAX_COLLECTIONS_COUNT = 500;

type DataSourceValues = {
  key?: string;
  type?: string;
  options?: ElasticsearchDataSourceOptions;
  collections?: unknown;
  addAllCollections?: boolean;
};

type ActionContext = {
  action?: {
    actionName?: string;
    resourceName?: string;
    params?: {
      actionName?: string;
      resourceName?: string;
      values?: DataSourceValues;
      filterByTk?: string;
      associatedIndex?: string;
    };
  };
  request: {
    body?: unknown;
  };
  body?: unknown;
  db: {
    getRepository: (name: string) => {
      findByTargetKey?: (key: string) => Promise<{ get: (name: string) => unknown } | null>;
      destroy: (options: { filter: Record<string, unknown> }) => Promise<unknown>;
    };
  };
  logger?: {
    error: (...args: unknown[]) => void;
  };
  throw: (status: number, message: string) => void;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSubmittedOptions(values: DataSourceValues): ElasticsearchDataSourceOptions {
  const options = getElasticsearchConnectionOptions(values.options || {});
  const addAllCollections =
    typeof values.addAllCollections === 'boolean' ? values.addAllCollections : options.addAllCollections !== false;

  if (addAllCollections === false) {
    return {
      ...options,
      addAllCollections: false,
      selectedCollections: normalizeElasticsearchCollectionNames(values.collections || options.selectedCollections),
    };
  }

  const { selectedCollections, ...rest } = options;
  return {
    ...rest,
    addAllCollections: true,
  };
}

export class PluginDataSourceElasticsearchServer extends Plugin {
  async beforeLoad() {
    await this.db.import({ directory: path.resolve(__dirname, 'collections') });
    this.app.dataSourceManager.factory.register('elasticsearch', ElasticsearchDataSource);
  }

  async load() {
    this.app.resourceManager.define({
      name: 'external-elasticsearch',
      actions: {
        testConnection: async (ctx: ActionContext, next: () => Promise<void>) => {
          const payload = (ctx.action?.params?.values || ctx.request.body || {}) as ElasticsearchDataSourceOptions;
          const connectionOptions = getElasticsearchConnectionOptions(payload);

          try {
            await ElasticsearchDataSource.testConnection(connectionOptions);
            ctx.body = { success: true };
          } catch (error) {
            ctx.throw(400, getErrorMessage(error));
          }

          await next();
        },
        readIndices: async (ctx: ActionContext, next: () => Promise<void>) => {
          const payload = (ctx.action?.params?.values || ctx.request.body || {}) as ElasticsearchDataSourceOptions;
          const connectionOptions = getElasticsearchConnectionOptions(payload);

          try {
            ctx.body = await ElasticsearchDataSource.readIndices(connectionOptions);
          } catch (error) {
            ctx.throw(400, getErrorMessage(error));
          }

          await next();
        },
      },
      only: ['testConnection', 'readIndices'],
    });

    this.app.resourceManager.use(async (ctx: ActionContext, next: () => Promise<void>) => {
      const { actionName, resourceName, params } = ctx.action || {};

      if (resourceName !== 'dataSources' || !['create', 'update'].includes(actionName || '')) {
        await next();
        return;
      }

      const values = params?.values;
      if (!values) {
        await next();
        return;
      }

      const isElasticsearch =
        values.type === 'elasticsearch' ||
        (actionName === 'update' && (await this.isElasticsearchDataSource(ctx, params?.filterByTk)));

      if (!isElasticsearch || !values.options) {
        await next();
        return;
      }

      const options = normalizeSubmittedOptions(values);
      values.options = options;
      delete values.collections;
      delete values.addAllCollections;

      const dsName = actionName === 'update' ? params?.filterByTk : values.key;
      const tempDs = this.app.dataSourceManager.factory.create('elasticsearch', {
        name: dsName,
        ...options,
      }) as ElasticsearchDataSource;

      tempDs.setLogger(ctx.logger || this.app.logger);

      try {
        if (options.addAllCollections === false) {
          const selectedCollections = normalizeElasticsearchCollectionNames(options.selectedCollections);
          if (selectedCollections.length > 0) {
            await tempDs.loadTables(ctx, selectedCollections);
          }
        } else {
          const allIndices = await tempDs.readTables();
          if (allIndices.length > MAX_COLLECTIONS_COUNT) {
            throw new Error(
              `The number of collections exceeds the limit of ${MAX_COLLECTIONS_COUNT}. ` +
                'Please remove some collections before adding new ones.',
            );
          }
        }
      } catch (error) {
        this.app.logger.error('[Elasticsearch] Failed to process collections during create/update:', error);
        throw error;
      } finally {
        await tempDs.close();
      }

      await next();
    });

    this.app.resourceManager.use(async (ctx: ActionContext, next: () => Promise<void>) => {
      const resourceName = ctx.action?.resourceName || ctx.action?.params?.resourceName;
      const actionName = ctx.action?.actionName || ctx.action?.params?.actionName;
      const dataSourceKey = ctx.action?.params?.associatedIndex;

      if (resourceName !== 'dataSources.collections' || actionName !== 'destroy' || !dataSourceKey) {
        await next();
        return;
      }

      const dataSource = this.app.dataSourceManager.dataSources.get(dataSourceKey);

      if (!(dataSource instanceof ElasticsearchDataSource)) {
        await next();
        return;
      }

      const collectionName = ctx.action?.params?.filterByTk;
      if (!collectionName) {
        await next();
        return;
      }

      await ctx.db.getRepository('dataSourcesCollections').destroy({
        filter: {
          name: collectionName,
          dataSourceKey,
        },
      });

      await ctx.db.getRepository('dataSourcesFields').destroy({
        filter: {
          collectionName,
          dataSourceKey,
        },
      });

      dataSource.collectionManager.removeCollection(collectionName);
      ctx.body = { success: true };
    });

    this.app.acl.registerSnippet({
      name: 'pm.data-source-manager.elasticsearch',
      actions: ['external-elasticsearch:*'],
    });

    this.app.acl.allow('external-elasticsearch', ['testConnection', 'readIndices'], 'loggedIn');
  }

  private async isElasticsearchDataSource(ctx: ActionContext, filterByTk?: string): Promise<boolean> {
    if (!filterByTk) {
      return false;
    }

    try {
      const dataSourcesRepo = ctx.db.getRepository('dataSources');
      const model = await dataSourcesRepo.findByTargetKey?.(filterByTk);
      return model?.get('type') === 'elasticsearch';
    } catch {
      return false;
    }
  }
}

export default PluginDataSourceElasticsearchServer;
