// SPDX-License-Identifier: Apache-2.0

import { MssqlExternalDataSource, type MssqlDataSourceOptions } from '../data-source/MssqlExternalDataSource';
import type { Context } from '@nocobase/actions';
import { describe, expect, it, vi } from 'vitest';

function createDataSource(options: MssqlDataSourceOptions) {
  const getTables = vi.fn().mockResolvedValue(['users', 'orders', 'products']);
  const preloadAllColumns = vi.fn().mockResolvedValue(undefined);
  const preloadAllPrimaryKeys = vi.fn().mockResolvedValue(undefined);
  const preloadFTSIndexedColumns = vi.fn().mockResolvedValue(undefined);
  const getCollection = vi.fn(async ({ tableInfo, localOptions }) => ({
    name: tableInfo.tableName,
    title: localOptions.title ?? tableInfo.tableName,
    fields: localOptions.fields ?? [{ name: 'id', type: 'integer' }],
  }));
  const defineCollection = vi.fn();
  const authenticate = vi.fn().mockResolvedValue(undefined);
  const registerOperators = vi.fn();
  const db = {
    options: { schema: 'dbo' },
    sequelize: { authenticate },
    checkVersion: vi.fn().mockResolvedValue(undefined),
    registerOperators,
  };
  const introspector = {
    getTables,
    tableInfoToCollectionOptions: ({ tableName }: { tableName: string }) => ({ name: tableName }),
    getCollection,
    preloadAllColumns,
    preloadAllPrimaryKeys,
    preloadFTSIndexedColumns,
  };
  const dataSource = Object.create(MssqlExternalDataSource.prototype) as MssqlExternalDataSource;
  Object.assign(dataSource, {
    options,
    collectionManager: { db, defineCollection },
    introspector,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emitLoadingProgress: vi.fn(),
  });

  return {
    dataSource,
    getTables,
    getCollection,
    preloadAllColumns,
    preloadAllPrimaryKeys,
    preloadFTSIndexedColumns,
    defineCollection,
    registerOperators,
    authenticate,
  };
}

describe('MSSQL selected collection loading', () => {
  it('introspects only saved selections and merges each with its persisted local metadata', async () => {
    const localCollection = {
      name: 'orders',
      title: 'Sales orders',
      fields: [{ name: 'orderTotal', type: 'decimal', title: 'Total' }],
    };
    const spies = createDataSource({
      addAllCollections: false,
      selectedCollections: ['orders'],
    });

    await spies.dataSource.load({ localData: { orders: localCollection } });

    expect(spies.authenticate).toHaveBeenCalledOnce();
    expect(spies.getTables).not.toHaveBeenCalled();
    expect(spies.preloadAllColumns).not.toHaveBeenCalled();
    expect(spies.preloadAllPrimaryKeys).not.toHaveBeenCalled();
    expect(spies.preloadFTSIndexedColumns).toHaveBeenCalledWith('dbo', ['orders']);
    expect(spies.getCollection).toHaveBeenCalledTimes(1);
    expect(spies.getCollection).toHaveBeenCalledWith({
      tableInfo: { tableName: 'orders', schema: 'dbo' },
      localOptions: localCollection,
    });
    expect(spies.defineCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orders',
        title: 'Sales orders',
        fields: localCollection.fields,
        introspected: true,
        repository: 'mssql-repo',
      }),
    );
  });

  it('does no external schema introspection when the saved selection is empty', async () => {
    const spies = createDataSource({ addAllCollections: false, selectedCollections: [] });

    await spies.dataSource.load();

    expect(spies.authenticate).toHaveBeenCalledOnce();
    expect(spies.getTables).not.toHaveBeenCalled();
    expect(spies.preloadAllColumns).not.toHaveBeenCalled();
    expect(spies.preloadAllPrimaryKeys).not.toHaveBeenCalled();
    expect(spies.preloadFTSIndexedColumns).not.toHaveBeenCalled();
    expect(spies.getCollection).not.toHaveBeenCalled();
    expect(spies.defineCollection).not.toHaveBeenCalled();
  });

  it.each(['create', 'update'] as const)(
    'persists the selected collection names on datasource %s options',
    async (actionName) => {
      const spies = createDataSource({ addAllCollections: false });
      const ctx = {
        action: {
          actionName,
          resourceName: 'dataSources',
          params: {
            values: {
              options: { host: 'db.test', addAllCollections: false },
              collections: ['orders', 'users', 'orders'],
            },
          },
        },
      } as unknown as Context;

      await spies.dataSource.loadTables(ctx, ['orders', 'users', 'orders']);

      expect(ctx.action.params.values.options).toMatchObject({
        host: 'db.test',
        addAllCollections: false,
        selectedCollections: ['orders', 'users'],
      });
    },
  );

  it('persists an empty selection rather than treating it as a missing selection', async () => {
    const spies = createDataSource({ addAllCollections: false });
    const ctx = {
      action: {
        actionName: 'create',
        resourceName: 'dataSources',
        params: {
          values: { options: { addAllCollections: false }, collections: [] },
        },
      },
    } as unknown as Context;

    await spies.dataSource.loadTables(ctx, []);

    expect(ctx.action.params.values.options).toMatchObject({ addAllCollections: false, selectedCollections: [] });
  });

  it.each([
    ['explicit load all', { addAllCollections: true }],
    ['legacy false without a saved selection', { addAllCollections: false }],
    ['legacy missing load-all option', {}],
  ])('%s retains the historical full-load behavior', async (_label, options) => {
    const spies = createDataSource(options);

    await spies.dataSource.load();

    expect(spies.getTables).toHaveBeenCalledOnce();
    expect(spies.preloadAllColumns).toHaveBeenCalledWith('dbo');
    expect(spies.preloadAllPrimaryKeys).toHaveBeenCalledWith('dbo');
    expect(spies.preloadFTSIndexedColumns).toHaveBeenCalledWith('dbo', undefined);
    expect(spies.getCollection).toHaveBeenCalledTimes(3);
    expect(spies.defineCollection).toHaveBeenCalledTimes(3);
  });
});
