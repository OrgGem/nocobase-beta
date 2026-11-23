/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { DataSourceManager } from '@nocobase/data-source-manager';
import { Database, Model, Repository } from '@nocobase/database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_SOURCE_TYPE, NAMESPACE } from '../../constants';
import { PostgresAdjacencyListRepository } from '../collections/adjacency-list-repository';
import { PostgresSQLCollection } from '../collections/sql-collection';
import { PostgresTreeCollection } from '../collections/tree-collection';
import { PluginDataSourcePostgresServer } from '../plugin';
import { PostgresDataSource } from '../postgres-datasource';

const sourcesToClose: PostgresDataSource[] = [];

function createDataSource(extra: Record<string, unknown> = {}) {
  const ds = new PostgresDataSource({
    name: 'pg-unit',
    host: '127.0.0.1',
    port: 5432,
    database: 'sales',
    username: 'postgres',
    password: 'secret-password',
    ssl: true,
    sslCa: '-----BEGIN CERTIFICATE-----',
    addAllCollections: false,
    selectedCollections: ['orders'],
    ...extra,
  });
  sourcesToClose.push(ds);
  return ds;
}

afterEach(async () => {
  while (sourcesToClose.length) {
    const ds = sourcesToClose.pop();
    if (ds) await ds.close();
  }
  vi.restoreAllMocks();
});

describe('PostgresDataSource unit behavior', () => {
  it('returns null from publicOptions so secrets, hosts, certs, and tables are never exposed', () => {
    const ds = createDataSource();
    expect(ds.publicOptions()).toBeNull();
  });

  it('batches identity and relkind queries in prepareTables instead of running N+1 queries', async () => {
    const ds = createDataSource();
    const querySpy = vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('information_schema.columns')) {
        return [{ tableName: 'orders', name: 'id' }] as never;
      }
      if (text.includes('pg_catalog.pg_class')) {
        return [
          { tableName: 'orders', kind: 'r' },
          { tableName: 'order_view', kind: 'v' },
          { tableName: 'order_mat_view', kind: 'm' },
        ] as never;
      }
      return [] as never;
    });
    vi.spyOn(ds.introspector, 'getCollection').mockImplementation(async ({ tableInfo }) => ({
      name: tableInfo.tableName,
      tableName: tableInfo.tableName,
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    }));

    const prepared = await ds.prepareTables(['orders', 'order_view', 'order_mat_view']);

    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(prepared.map((item) => item.name)).toEqual(['orders', 'order_view', 'order_mat_view']);
    expect(prepared[0].fields?.[0]?.autoIncrement).toBe(true);
    expect(prepared[1]).toMatchObject({ view: true, template: 'view', writableView: false });
    expect(prepared[2]).toMatchObject({ view: true, template: 'view', writableView: false });
  });

  it('introspects materialized views via pg_catalog, sets filterTargetKey on views, and rejects matview collisions in createTable', async () => {
    const ds = createDataSource();
    const queryInterface = ds.collectionManager.db.sequelize.getQueryInterface();
    vi.spyOn(queryInterface, 'describeTable').mockImplementation(async (tableName) => {
      const name = typeof tableName === 'object' && tableName ? tableName.tableName : String(tableName);
      if (name === 'transient_error_table') {
        throw new Error('Connection terminated unexpectedly');
      }
      if (
        name === 'order_mat_view' ||
        name === 'bare_table' ||
        name === 'restricted_table' ||
        name === 'missing_table'
      ) {
        throw new Error(`No description found for "${name}" table.`);
      }
      return {
        id: {
          type: 'BIGINT',
          allowNull: true,
          defaultValue: '',
          primaryKey: false,
          autoIncrement: false,
          comment: null,
        },
        name: {
          type: 'TEXT',
          allowNull: true,
          defaultValue: '',
          primaryKey: false,
          autoIncrement: false,
          comment: null,
        },
      };
    });

    const executedQueries: string[] = [];
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockImplementation(async (sql, queryOpts) => {
      const text = String(sql);
      executedQueries.push(text);
      const tableName = (queryOpts as { replacements?: { tableName?: string } } | undefined)?.replacements?.tableName;
      if (text.includes('is_identity')) return [] as never;
      if (text.includes('SELECT c.relname AS "tableName", c.relkind AS kind')) {
        return [
          { tableName: 'order_view', kind: 'v' },
          { tableName: 'order_mat_view', kind: 'm' },
          { tableName: 'bare_table', kind: 'r' },
        ] as never;
      }
      if (text.includes("c.relkind = 'm'") && text.includes('pg_catalog.pg_attribute')) {
        if (tableName !== 'order_mat_view') return [] as never;
        return [
          { name: 'id', type: 'BIGINT', elementType: null, allowNull: false, comment: null },
          { name: 'code', type: 'CHARACTER VARYING(64)', elementType: null, allowNull: false, comment: 'Order code' },
          { name: 'tags', type: 'ARRAY', elementType: 'text', allowNull: true, comment: null },
        ] as never;
      }
      if (text.includes('pg_catalog.pg_index') && text.includes('AS column_name')) {
        expect(text).toContain('i.indisvalid AND i.indislive');
        return (tableName === 'order_mat_view' ? [{ column_name: 'code', is_single_column: true }] : []) as never;
      }
      if (text.includes('pg_catalog.pg_index') && text.includes('AS "isValid"')) {
        return [{ indexName: 'idx_bad', constraintName: null, isValid: false }] as never;
      }
      if (text.includes('AS empty')) {
        if (tableName === 'bare_table') return [{ empty: true }] as never;
        if (tableName === 'restricted_table') return [{ empty: false }] as never;
        return [] as never;
      }
      if (text.includes('SELECT c.relkind AS kind')) {
        if (tableName === 'order_mat_view') return [{ kind: 'm' }] as never;
        return [] as never;
      }
      if (text.includes('has_table_privilege')) {
        return [{ name: 'orders' }] as never;
      }
      return [] as never;
    });

    const prepared = await ds.prepareTables(['order_view', 'order_mat_view', 'bare_table']);
    expect(prepared[0]).toMatchObject({
      name: 'order_view',
      view: true,
      template: 'view',
      writableView: false,
      filterTargetKey: 'id',
    });
    expect(prepared[1]).toMatchObject({
      name: 'order_mat_view',
      view: true,
      template: 'view',
      writableView: false,
      filterTargetKey: 'code',
    });
    expect(prepared[1].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', type: 'bigInt' }),
        expect.objectContaining({ name: 'code', type: 'string', unique: true }),
        expect.objectContaining({ name: 'tags', type: 'array', elementType: 'text' }),
      ]),
    );
    expect(prepared[2]).toMatchObject({ name: 'bare_table', fields: [] });

    const [concurrentA, concurrentB] = await Promise.all([
      ds.prepareTables(['order_mat_view']),
      ds.prepareTables(['order_mat_view']),
    ]);
    expect(concurrentA[0].filterTargetKey).toBe('code');
    expect(concurrentB[0].filterTargetKey).toBe('code');

    await expect(ds.prepareTables(['restricted_table'])).rejects.toThrow(
      'No description found for "restricted_table" table.',
    );
    await expect(ds.prepareTables(['transient_error_table'])).rejects.toThrow('Connection terminated unexpectedly');
    await expect(ds.prepareTables(['missing_table'])).rejects.toThrow('missing_table');

    const discovered = await ds.collectionManager.discoverTables();
    expect(discovered).toEqual(['orders']);
    const discoverQuery = executedQueries.find((q) => q.includes('ORDER BY c.relname'));
    expect(discoverQuery).toContain('has_table_privilege');
    expect(discoverQuery).toContain('has_any_column_privilege');

    ds.collectionManager.defineCollection({
      name: 'orders',
      tableName: 'orders',
      fields: [{ name: 'name', type: 'string' }],
    });
    await ds.collectionManager.updateField('orders', 'name', { unique: true }, {} as never);
    expect(executedQueries.some((q) => q.startsWith('DROP INDEX "public"."idx_bad"'))).toBe(true);
    expect(executedQueries.some((q) => q.startsWith('CREATE UNIQUE INDEX '))).toBe(true);

    const created = await ds.collectionManager.createTable({ name: 'order_mat_view', fields: [] }, {} as never);
    expect(created).toBe(false);
  });
});

describe('PostgresTreeCollection and PostgresAdjacencyListRepository', () => {
  it('checks ancestors in a single CTE on beforeSave and skips work when parentId did not change', async () => {
    const db = new Database({
      dialect: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'unused',
      username: 'unused',
      logging: false,
    });
    try {
      db.collectionFactory.registerCollectionType(PostgresTreeCollection, {
        condition: (options) => Boolean(options.postgresTree || options.template === 'tree'),
      });
      const collection = db.collection({
        name: 'categories',
        template: 'tree',
        tree: 'parentId',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'name', type: 'string' },
          { name: 'parentId', type: 'integer' },
        ],
      }) as PostgresTreeCollection;

      const querySpy = vi.spyOn(db.sequelize, 'query').mockImplementation(async (sql) => {
        if (String(sql).includes('WITH RECURSIVE ancestors')) {
          return [{ hasCycle: false }] as never;
        }
        return [] as never;
      });
      const findOneSpy = vi.spyOn(collection.repository, 'findOne');

      const unchangedNode = collection.model.build({ id: 2, name: 'Updated', parentId: 1 }, { isNewRecord: false });
      vi.spyOn(unchangedNode, 'changed').mockReturnValue(false);
      await (collection.model as unknown as { runHooks: (name: string, ...args: unknown[]) => Promise<void> }).runHooks(
        'beforeSave',
        unchangedNode,
        {},
      );
      expect(querySpy).not.toHaveBeenCalled();

      const movedNode = collection.model.build({ id: 2, name: 'Moved', parentId: 3 }, { isNewRecord: false });
      vi.spyOn(movedNode, 'changed').mockReturnValue(true);
      const tx = {} as never;
      await (collection.model as unknown as { runHooks: (name: string, ...args: unknown[]) => Promise<void> }).runHooks(
        'beforeSave',
        movedNode,
        { transaction: tx },
      );
      expect(querySpy).toHaveBeenCalledTimes(2);
      expect(String(querySpy.mock.calls[0][0])).toContain('pg_advisory_xact_lock');
      expect(String(querySpy.mock.calls[1][0])).toContain('WITH RECURSIVE ancestors');
      expect(findOneSpy).not.toHaveBeenCalled();

      const selfParent = collection.model.build({ id: 2, name: 'Self', parentId: 2 }, { isNewRecord: false });
      vi.spyOn(selfParent, 'changed').mockReturnValue(true);
      await expect(
        (collection.model as unknown as { runHooks: (name: string, ...args: unknown[]) => Promise<void> }).runHooks(
          'beforeSave',
          selfParent,
          { transaction: tx },
        ),
      ).rejects.toMatchObject({ name: 'PostgresValidationError', status: 400 });

      querySpy.mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ hasCycle: true }] as never);
      await expect(
        (collection.model as unknown as { runHooks: (name: string, ...args: unknown[]) => Promise<void> }).runHooks(
          'beforeSave',
          movedNode,
          { transaction: tx },
        ),
      ).rejects.toThrow('Cycle detected in tree collection categories');
    } finally {
      await db.close();
    }
  });

  it('paginates unfiltered roots with CTE, respects mixed empty $and filters, and keeps required tree fields', async () => {
    const db = new Database({
      dialect: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'unused',
      username: 'unused',
      logging: false,
    });
    try {
      db.collectionFactory.registerCollectionType(PostgresTreeCollection, {
        condition: (options) => Boolean(options.postgresTree || options.template === 'tree'),
      });
      const collection = db.collection({
        name: 'categories',
        template: 'tree',
        tree: 'parentId',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'name', type: 'string' },
          { name: 'parentId', type: 'integer' },
        ],
      }) as PostgresTreeCollection;
      const repo = collection.repository as PostgresAdjacencyListRepository;

      const root1 = collection.model.build({ id: 1, name: 'Root 1', parentId: null });
      const child1 = collection.model.build({ id: 2, name: 'Child 1', parentId: 1 });
      const root2 = collection.model.build({ id: 3, name: 'Root 2', parentId: null });
      const child2 = collection.model.build({ id: 4, name: 'Child 2', parentId: 3 });

      const querySpy = vi.spyOn(db.sequelize, 'query').mockImplementation(async (sql, queryOpts) => {
        const text = String(sql);
        if (text.includes('SELECT COUNT(*)::int AS count')) {
          return [{ count: 2 }] as never;
        }
        if (text.includes('ORDER BY') && text.includes('LIMIT :limit')) {
          return [{ id: 3 }] as never;
        }
        if (text.includes('WITH RECURSIVE tree')) {
          const seedIds = ((queryOpts as { replacements?: { seedIds?: number[] } } | undefined)?.replacements
            ?.seedIds || []) as number[];
          const all = [
            { id: 3, parentId: null, hasCycle: false },
            { id: 4, parentId: 3, hasCycle: false },
          ];
          return (seedIds.includes(3) ? all : all.filter((row) => seedIds.includes(row.id))) as never;
        }
        return [] as never;
      });
      const superFindSpy = vi.spyOn(Repository.prototype, 'find').mockImplementation(async (opts) => {
        const ids = (opts?.filter as { id?: number[] } | undefined)?.id;
        if (ids) {
          return [root1, child1, root2, child2].filter((item) => ids.includes(Number(item.get('id')))) as Model[];
        }
        if ((opts?.filter as { name?: string } | undefined)?.name === 'Root 2') {
          return [root2] as Model[];
        }
        return [child2] as Model[];
      });

      const [pagedRoots, total] = await repo.findAndCount({ tree: true, limit: 1, offset: 1, fields: ['name'] });
      expect(total).toBe(2);
      expect(pagedRoots.map((node) => node.get('name'))).toEqual(['Root 2']);
      expect(pagedRoots[0].get('children').map((node: Model) => node.get('name'))).toEqual(['Child 2']);
      expect(superFindSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filter: { id: [3, 4] }, fields: ['name', 'id', 'parentId'] }),
      );

      const filteredParent = await repo.find({ tree: true, filter: { name: 'Root 2' } });
      expect(filteredParent.map((node) => node.get('name'))).toEqual(['Root 2']);
      expect(filteredParent[0].get('children').map((node: Model) => node.get('name'))).toEqual(['Child 2']);

      const mixedFilter = await repo.find({ tree: true, filter: { name: 'Root 2', $and: [] } });
      expect(mixedFilter.map((node) => node.get('name'))).toEqual(['Root 2']);
      expect(superFindSpy).toHaveBeenCalledWith(
        expect.objectContaining({ filter: { name: 'Root 2', $and: [] }, tree: false }),
      );

      const filteredChild = await repo.find({ tree: true, filter: { name: 'Child 2' } });
      expect(filteredChild.map((node) => node.get('name'))).toEqual(['Child 2']);

      querySpy
        .mockResolvedValueOnce([{ id: 3 }] as never)
        .mockResolvedValueOnce([{ id: 3, parentId: 4, hasCycle: true }] as never);
      await expect(repo.find({ tree: true })).rejects.toThrow('Cycle detected in tree collection categories');
    } finally {
      await db.close();
    }
  });
});

describe('PluginDataSourcePostgresServer middleware and sync', () => {
  function createPluginHarness() {
    const preHandlers = new Map<string, (ctx: unknown, next: () => Promise<void>) => Promise<void>>();
    const middlewares: Array<(ctx: unknown, next: () => Promise<void>) => Promise<void>> = [];
    const dataSourceManager = new DataSourceManager();
    dataSourceManager.registerDataSourceType(DATA_SOURCE_TYPE, PostgresDataSource);

    const ds = createDataSource({ name: 'pg-ext' });
    ds.collectionManager.defineCollection({
      name: 'orders',
      tableName: 'orders',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'note', type: 'string' },
      ],
    });
    dataSourceManager.dataSources.set('pg-ext', ds);

    const fieldsRepo = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    const collectionsRepo = {
      findOne: vi.fn().mockResolvedValue(null),
    };
    const dataSourcesRepo = {
      findOne: vi.fn().mockResolvedValue(null),
    };
    const dbEvents = new Map<string, Array<(...args: unknown[]) => Promise<void> | void>>();
    const sendSyncMessage = vi.fn().mockResolvedValue(undefined);
    const app = {
      dataSourceManager,
      environment: {
        renderJsonTemplate: vi.fn((val) => ({
          ...val,
          password: val.password === '{{PG_PASS}}' ? 'resolved' : val.password,
        })),
      },
      log: { warn: vi.fn() },
      db: {
        getRepository: (name: string) => {
          if (name === 'dataSourcesFields') return fieldsRepo;
          if (name === 'dataSources') return dataSourcesRepo;
          return collectionsRepo;
        },
        on: (event: string, listener: (...args: unknown[]) => Promise<void> | void) => {
          const list = dbEvents.get(event) || [];
          list.push(listener);
          dbEvents.set(event, list);
        },
      },
      resourceManager: {
        registerPreActionHandler: (name: string, fn: (ctx: unknown, next: () => Promise<void>) => Promise<void>) => {
          preHandlers.set(name, fn);
        },
        use: (fn: (ctx: unknown, next: () => Promise<void>) => Promise<void>) => {
          middlewares.push(fn);
        },
      },
    };
    const plugin = new PluginDataSourcePostgresServer(app as never, { name: NAMESPACE });
    plugin.sendSyncMessage = sendSyncMessage;
    return {
      plugin,
      ds,
      preHandlers,
      middlewares,
      fieldsRepo,
      collectionsRepo,
      dataSourcesRepo,
      dbEvents,
      sendSyncMessage,
      app,
    };
  }

  it('rejects nested options.sql on create/update and forbids converting table collections to SQL', async () => {
    const { plugin, middlewares } = createPluginHarness();
    await plugin.load();
    const schemaMiddleware = middlewares[1];

    await expect(
      schemaMiddleware(
        {
          action: {
            resourceName: 'dataSources.collections',
            actionName: 'create',
            params: {
              associatedIndex: 'pg-ext',
              values: { name: 'bad_sql', options: { sql: 'SELECT * FROM pg_settings' } },
            },
          },
        },
        vi.fn(),
      ),
    ).rejects.toThrow('SQL statement contains dangerous keyword: pg_settings');

    const ctxThrow = vi.fn((status: number, message: string) => {
      throw new Error(`${status}:${message}`);
    });
    await expect(
      schemaMiddleware(
        {
          action: {
            resourceName: 'dataSources.collections',
            actionName: 'update',
            params: {
              associatedIndex: 'pg-ext',
              filterByTk: 'orders',
              values: { options: { sql: 'SELECT 1' } },
            },
          },
          throw: ctxThrow,
        },
        vi.fn(),
      ),
    ).rejects.toThrow('400:Only SQL collections can update SQL queries');
  });

  it('intercepts standalone fields:apply from request.body and emits fieldRemoved sync on introspected field delete', async () => {
    const { plugin, ds, middlewares, sendSyncMessage } = createPluginHarness();
    await plugin.load();
    const schemaMiddleware = middlewares[1];

    const ensureForeignKey = vi.spyOn(ds.collectionManager, 'ensureForeignKey').mockResolvedValue(undefined);
    vi.spyOn(ds.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
      cb: (tx: unknown) => Promise<unknown>,
    ) => cb({})) as never);
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockResolvedValue([] as never);

    const body: Record<string, unknown> = {
      dataSourceKey: 'pg-ext',
      collectionName: 'orders',
      name: 'customer',
      interface: 'm2o',
      target: 'customers',
    };
    const nextApply = vi.fn().mockResolvedValue(undefined);
    await schemaMiddleware(
      {
        action: { resourceName: 'dataSourcesCollections.fields', actionName: 'apply', params: {} },
        request: { body },
        db: {
          getRepository: () => ({ find: vi.fn().mockResolvedValue([]), findOne: vi.fn().mockResolvedValue(null) }),
        },
      },
      nextApply,
    );
    expect(ensureForeignKey).toHaveBeenCalledOnce();
    expect(body).toMatchObject({ type: 'belongsTo', foreignKey: 'customerId', targetKey: 'id' });
    expect(nextApply).toHaveBeenCalledOnce();

    vi.spyOn(ds.collectionManager, 'removeField').mockResolvedValue(undefined);
    const nextDestroy = vi.fn().mockResolvedValue(undefined);
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSourcesCollections.fields',
          actionName: 'destroy',
          params: { associatedIndex: 'pg-ext.orders', filterByTk: 'note' },
        },
        db: {
          getRepository: () => ({
            find: vi.fn().mockResolvedValue([]),
            findOne: vi.fn().mockResolvedValue({ key: 'f1' }),
          }),
        },
      },
      nextDestroy,
    );
    expect(sendSyncMessage).toHaveBeenCalledWith({
      type: 'fieldRemoved',
      dataSourceKey: 'pg-ext',
      collectionName: 'orders',
      fieldName: 'note',
    });

    ds.collectionManager.getCollection('orders')?.setField('extra', { name: 'extra', type: 'string' });
    await plugin.handleSyncMessage({
      type: 'fieldRemoved',
      dataSourceKey: 'pg-ext',
      collectionName: 'orders',
      fieldName: 'extra',
    });
    expect(ds.collectionManager.getCollection('orders')?.getField('extra')).toBeUndefined();
  });

  it('broadcasts and handles collectionCreated and collectionRemoved sync messages across HA nodes', async () => {
    const { plugin, ds, middlewares, collectionsRepo, sendSyncMessage } = createPluginHarness();
    await plugin.load();
    const schemaMiddleware = middlewares[1];

    vi.spyOn(ds.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
      cb: (tx: unknown) => Promise<unknown>,
    ) => cb({})) as never);
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockResolvedValue([] as never);
    vi.spyOn(ds.collectionManager, 'createTable').mockImplementation(async (values) => {
      ds.collectionManager.defineCollection({ name: String(values.name), tableName: String(values.name), fields: [] });
      return true;
    });
    vi.spyOn(ds, 'addSelectedTables').mockResolvedValue(undefined);
    vi.spyOn(ds, 'removeSelectedTables').mockResolvedValue(undefined);
    vi.spyOn(ds.collectionManager, 'dropTable').mockResolvedValue(undefined);

    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'create',
          params: { associatedIndex: 'pg-ext', values: { name: 'invoices', fields: [{ name: 'id', type: 'bigInt' }] } },
        },
      },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(sendSyncMessage).toHaveBeenCalledWith({
      type: 'collectionCreated',
      dataSourceKey: 'pg-ext',
      collectionName: 'invoices',
    });

    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: { associatedIndex: 'pg-ext', filterByTk: 'invoices' },
        },
      },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(sendSyncMessage).toHaveBeenCalledWith({
      type: 'collectionRemoved',
      dataSourceKey: 'pg-ext',
      collectionNames: ['invoices'],
    });

    collectionsRepo.findOne.mockResolvedValueOnce({
      toJSON: () => ({ name: 'invoices_sql', sql: 'SELECT 1 AS id' }),
    });
    await plugin.handleSyncMessage({
      type: 'collectionCreated',
      dataSourceKey: 'pg-ext',
      collectionName: 'invoices_sql',
    });
    expect(ds.collectionManager.hasCollection('invoices_sql')).toBe(true);

    await plugin.handleSyncMessage({
      type: 'collectionRemoved',
      dataSourceKey: 'pg-ext',
      collectionNames: ['invoices_sql'],
    });
    expect(ds.collectionManager.hasCollection('invoices_sql')).toBe(false);
  });

  it('probes readTables with rendered templates and closes probe connection in finally', async () => {
    const { plugin, preHandlers } = createPluginHarness();
    await plugin.load();
    const handler = preHandlers.get('dataSources:readTables');
    expect(handler).toBeDefined();

    const readTablesSpy = vi
      .spyOn(PostgresDataSource.prototype, 'readTables')
      .mockRejectedValue(new Error('auth failed'));
    const closeSpy = vi.spyOn(PostgresDataSource.prototype, 'close').mockResolvedValue(undefined);

    const ctx = {
      action: {
        params: {
          values: {
            dataSourceKey: 'probe-key',
            dbOptions: {
              type: DATA_SOURCE_TYPE,
              host: '127.0.0.1',
              database: 'sales',
              username: 'postgres',
              password: '{{PG_PASS}}',
            },
          },
        },
      },
      body: undefined as unknown,
    };

    await expect(handler?.(ctx, vi.fn())).rejects.toThrow('auth failed');
    expect(readTablesSpy).toHaveBeenCalledOnce();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('validates SQL update, preserves model attributes on sync, and notifies HA peers', async () => {
    const { plugin, ds, middlewares, collectionsRepo, fieldsRepo, sendSyncMessage } = createPluginHarness();
    await plugin.load();
    ds.collectionManager.db.collectionFactory.registerCollectionType(PostgresSQLCollection, {
      condition: (options) => Boolean(options.sql),
      async onSync() {},
      async onDump() {},
    });
    const sqlCollection = ds.collectionManager.defineCollection({
      name: 'order_view_sql',
      sql: 'SELECT id FROM orders',
      fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    }) as PostgresSQLCollection;

    const schemaMiddleware = middlewares[1];
    const next = vi.fn().mockResolvedValue(undefined);
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'update',
          params: {
            associatedIndex: 'pg-ext',
            filterByTk: 'order_view_sql',
            values: { sql: 'SELECT id FROM paid_orders' },
          },
        },
      },
      next,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(sendSyncMessage).toHaveBeenCalledWith({
      type: 'collectionCreated',
      dataSourceKey: 'pg-ext',
      collectionName: 'order_view_sql',
    });

    collectionsRepo.findOne.mockResolvedValueOnce({
      toJSON: () => ({ name: 'order_view_sql', sql: 'SELECT id FROM paid_orders' }),
    });
    fieldsRepo.find.mockResolvedValueOnce([{ toJSON: () => ({ name: 'id', type: 'integer', primaryKey: true }) }]);
    await plugin.handleSyncMessage({
      type: 'collectionCreated',
      dataSourceKey: 'pg-ext',
      collectionName: 'order_view_sql',
    });

    expect((sqlCollection.model as unknown as { sql?: string }).sql).toBe('SELECT id FROM paid_orders');
    expect(sqlCollection.model.getAttributes().id).toBeDefined();
    expect(sqlCollection.filterTargetKey).toBe('id');
  });

  it('allows metadata field CRUD on SQL collections, keeps views locked, and syncs v1 general preset flags', async () => {
    const { plugin, ds, middlewares, sendSyncMessage } = createPluginHarness();
    await plugin.load();
    ds.collectionManager.db.collectionFactory.registerCollectionType(PostgresSQLCollection, {
      condition: (options) => Boolean(options.sql),
      async onSync() {},
      async onDump() {},
    });
    const sqlCollection = ds.collectionManager.defineCollection({
      name: 'report_sql',
      sql: 'SELECT id, total FROM orders',
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    }) as PostgresSQLCollection;
    ds.collectionManager.defineCollection({
      name: 'order_names_view',
      view: true,
      viewName: 'order_names_view',
      fields: [{ name: 'id', type: 'bigInt' }],
    });

    const addFieldSpy = vi.spyOn(ds.collectionManager, 'addField');
    const removeFieldSpy = vi.spyOn(ds.collectionManager, 'removeField');
    const schemaMiddleware = middlewares[1];

    const nextCreateSqlField = vi.fn().mockImplementation(async () => {
      sqlCollection.setField('total', { name: 'total', type: 'decimal' });
    });
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSourcesCollections.fields',
          actionName: 'create',
          params: { associatedIndex: 'pg-ext.report_sql', values: { name: 'total', type: 'decimal' } },
        },
      },
      nextCreateSqlField,
    );
    expect(nextCreateSqlField).toHaveBeenCalledOnce();
    expect(addFieldSpy).not.toHaveBeenCalled();

    const nextDestroySqlField = vi.fn().mockImplementation(async () => {
      sqlCollection.removeField('total');
    });
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSourcesCollections.fields',
          actionName: 'destroy',
          params: { associatedIndex: 'pg-ext.report_sql', filterByTk: 'total' },
        },
      },
      nextDestroySqlField,
    );
    expect(nextDestroySqlField).toHaveBeenCalledOnce();
    expect(removeFieldSpy).not.toHaveBeenCalled();
    expect(sqlCollection.getField('total')).toBeUndefined();
    expect(sendSyncMessage).toHaveBeenCalledWith({
      type: 'fieldRemoved',
      dataSourceKey: 'pg-ext',
      collectionName: 'report_sql',
      fieldName: 'total',
    });

    const ctxThrow = vi.fn((status: number, message: string) => {
      throw new Error(`${status}:${message}`);
    });
    await expect(
      schemaMiddleware(
        {
          action: {
            resourceName: 'dataSourcesCollections.fields',
            actionName: 'create',
            params: { associatedIndex: 'pg-ext.order_names_view', values: { name: 'extra', type: 'string' } },
          },
          throw: ctxThrow,
        },
        vi.fn(),
      ),
    ).rejects.toThrow('403:This collection is read-only');

    vi.spyOn(ds.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
      cb: (tx: unknown) => Promise<unknown>,
    ) => cb({})) as never);
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockResolvedValue([] as never);
    const createTableSpy = vi.spyOn(ds.collectionManager, 'createTable').mockImplementation(async (values) => {
      ds.collectionManager.defineCollection({ name: String(values.name), tableName: String(values.name), fields: [] });
      return true;
    });
    vi.spyOn(ds, 'addSelectedTables').mockResolvedValue(undefined);

    const v1Values: Record<string, unknown> = {
      name: 'audit_logs',
      template: 'general',
      fields: ['id'],
      autoGenId: true,
      createdAt: true,
      updatedAt: true,
    };
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'create',
          params: { associatedIndex: 'pg-ext', values: v1Values },
        },
      },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(createTableSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'audit_logs',
        autoGenId: true,
        createdAt: false,
        updatedAt: false,
        timestamps: false,
      }),
      expect.anything(),
    );

    const v1CalendarValues: Record<string, unknown> = {
      name: 'events',
      template: 'calendar',
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true },
        { name: 'title', type: 'string' },
      ],
      autoGenId: true,
      createdAt: true,
      updatedAt: true,
    };
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'create',
          params: { associatedIndex: 'pg-ext', values: v1CalendarValues },
        },
      },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(createTableSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        name: 'events',
        fields: expect.arrayContaining([
          expect.objectContaining({ name: 'createdAt', interface: 'createdAt' }),
          expect.objectContaining({ name: 'updatedAt', interface: 'updatedAt' }),
        ]),
      }),
      expect.anything(),
    );
  });

  it('blocks writes to read-only views and SQL collections on both direct and nested relation actions', async () => {
    const { plugin, ds } = createPluginHarness();
    const registeredMiddlewares: Array<(ctx: unknown, next: () => Promise<void>) => Promise<void>> = [];
    vi.spyOn(ds.resourceManager, 'use').mockImplementation(
      (fn: (ctx: unknown, next: () => Promise<void>) => Promise<void>) => {
        registeredMiddlewares.push(fn);
        return ds.resourceManager;
      },
    );

    await plugin.beforeLoad();
    const readOnlyMiddleware = registeredMiddlewares[1];
    expect(readOnlyMiddleware).toBeDefined();

    ds.collectionManager.defineCollection({
      name: 'order_names_view',
      tableName: 'order_names_view',
      view: true,
      fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    });
    ds.collectionManager.defineCollection({
      name: 'order_sql',
      tableName: 'order_sql',
      sql: 'SELECT id FROM orders',
      fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    });
    ds.collectionManager.getCollection('orders')?.setField('orderViews', {
      name: 'orderViews',
      type: 'hasMany',
      target: 'order_names_view',
      foreignKey: 'id',
      sourceKey: 'id',
    });

    const ctxThrow = vi.fn((status: number, message: string) => {
      throw new Error(`${status}:${message}`);
    });

    await expect(
      readOnlyMiddleware(
        { action: { resourceName: 'order_names_view', actionName: 'move' }, throw: ctxThrow },
        vi.fn(),
      ),
    ).rejects.toThrow('403:This collection is read-only');

    await expect(
      readOnlyMiddleware(
        { action: { resourceName: 'orders.orderViews', actionName: 'create' }, throw: ctxThrow },
        vi.fn(),
      ),
    ).rejects.toThrow('403:This collection is read-only');

    await expect(
      readOnlyMiddleware(
        { action: { resourceName: 'orders.orderViews', actionName: 'update' }, throw: ctxThrow },
        vi.fn(),
      ),
    ).rejects.toThrow('403:This collection is read-only');

    const allowRead = vi.fn().mockResolvedValue(undefined);
    await readOnlyMiddleware(
      { action: { resourceName: 'orders.orderViews', actionName: 'list' }, throw: ctxThrow },
      allowRead,
    );
    expect(allowRead).toHaveBeenCalledOnce();

    const allowParentWrite = vi.fn().mockResolvedValue(undefined);
    await readOnlyMiddleware(
      { action: { resourceName: 'orders', actionName: 'create' }, throw: ctxThrow },
      allowParentWrite,
    );
    expect(allowParentWrite).toHaveBeenCalledOnce();
  });

  it('cleans up orphaned dataSourcesFields rows when destroying a collection', async () => {
    const { plugin, ds, middlewares, fieldsRepo } = createPluginHarness();
    await plugin.load();
    const schemaMiddleware = middlewares[1];

    vi.spyOn(ds.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
      cb: (tx: unknown) => Promise<unknown>,
    ) => cb({})) as never);
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockResolvedValue([] as never);
    vi.spyOn(ds.collectionManager, 'dropTable').mockResolvedValue(undefined);
    vi.spyOn(ds, 'removeSelectedTables').mockResolvedValue(false);

    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: { associatedIndex: 'pg-ext', filterByTk: 'orders' },
        },
      },
      vi.fn().mockResolvedValue(undefined),
    );

    expect(fieldsRepo.destroy).toHaveBeenCalledWith({
      filter: { dataSourceKey: 'pg-ext', collectionName: { $in: ['orders'] } },
      individualHooks: false,
      hooks: false,
    });
  });

  it('closes PostgreSQL pools on dataSources.afterDestroy and on HA dataSourceRemoved sync messages', async () => {
    const { plugin, ds, app, dbEvents, sendSyncMessage } = createPluginHarness();
    await plugin.beforeLoad();
    await plugin.load();

    const closeSpy = vi.spyOn(ds, 'close').mockResolvedValue(undefined);
    const destroyListeners = dbEvents.get('dataSources.afterDestroy') || [];
    expect(destroyListeners).toHaveLength(1);

    // Simulate upstream DataSourceManager removing the key from the map before our listener runs.
    app.dataSourceManager.dataSources.delete('pg-ext');
    let commitCallback: (() => Promise<void> | void) | undefined;
    const mockTx = {
      afterCommit: (fn: () => Promise<void> | void) => {
        commitCallback = fn;
      },
    };
    await destroyListeners[0](
      { get: (field: string) => (field === 'type' ? DATA_SOURCE_TYPE : field === 'key' ? 'pg-ext' : undefined) },
      { transaction: mockTx },
    );

    expect(closeSpy).not.toHaveBeenCalled();
    await commitCallback?.();
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(sendSyncMessage).toHaveBeenCalledWith(
      { type: 'dataSourceRemoved', dataSourceKey: 'pg-ext' },
      { transaction: mockTx },
    );

    // Simulate HA peer closing its tracked pool when receiving dataSourceRemoved.
    const peerSource = createDataSource({ name: 'pg-peer' });
    const peerCloseSpy = vi.spyOn(peerSource, 'close').mockResolvedValue(undefined);
    app.dataSourceManager.dataSources.set('pg-peer', peerSource);
    await plugin.beforeLoad();
    app.dataSourceManager.dataSources.delete('pg-peer');

    await plugin.handleSyncMessage({ type: 'dataSourceRemoved', dataSourceKey: 'pg-peer' });
    expect(peerCloseSpy).toHaveBeenCalledOnce();
  });

  it('preserves localData metadata in loadTables, broadcasts tablesLoaded in load-all mode, and syncs peers', async () => {
    const { plugin, ds, dataSourcesRepo, sendSyncMessage } = createPluginHarness();
    await plugin.load();

    const savedLocalData = {
      orders: {
        name: 'orders',
        tableName: 'orders',
        title: 'Custom Orders',
        fields: [{ name: 'note', type: 'string', title: 'Custom Note' }],
      },
    };
    dataSourcesRepo.findOne.mockResolvedValue({
      loadLocalData: vi.fn().mockResolvedValue(savedLocalData),
    });

    const prepareSpy = vi.spyOn(ds, 'prepareTables').mockResolvedValue([
      {
        name: 'orders',
        tableName: 'orders',
        title: 'Custom Orders',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'note', type: 'string', title: 'Custom Note' },
        ],
      },
    ]);
    const removeSpy = vi.spyOn(ds.collectionManager, 'removeCollection');
    vi.spyOn(ds, 'addSelectedTables').mockResolvedValue(false);
    vi.spyOn(ds.introspector, 'getTables').mockResolvedValue(['orders']);

    await ds.loadTables(
      {
        action: { resourceName: 'dataSources', actionName: 'loadTables', params: {} },
        db: { getRepository: () => dataSourcesRepo },
        app: { pm: { get: () => plugin } },
      } as never,
      ['orders'],
    );

    expect(prepareSpy).toHaveBeenCalledWith(['orders'], savedLocalData);
    expect(removeSpy).toHaveBeenCalledWith('orders');
    expect(ds.collectionManager.getCollection('orders')?.options.title).toBe('Custom Orders');
    expect(sendSyncMessage).toHaveBeenCalledWith({
      type: 'tablesLoaded',
      dataSourceKey: 'pg-ext',
      tableNames: ['orders'],
    });

    prepareSpy.mockClear();
    await plugin.handleSyncMessage({
      type: 'tablesLoaded',
      dataSourceKey: 'pg-ext',
      tableNames: ['orders'],
    });
    expect(prepareSpy).toHaveBeenCalledWith(['orders'], savedLocalData);
  });

  it('rejects virtual fields in addField and creates join tables with foreign keys in ensureJoinTable', async () => {
    const ds = createDataSource({ name: 'pg-ddl' });
    ds.collectionManager.defineCollection({
      name: 'orders',
      tableName: 'orders',
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    });
    ds.collectionManager.defineCollection({
      name: 'tags',
      tableName: 'tags',
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    });

    await expect(
      ds.collectionManager.addField('orders', { name: 'calc', type: 'virtual' }, {} as never),
    ).rejects.toThrow('Field type virtual does not represent a PostgreSQL column');

    const executed: string[] = [];
    let throughCreated = false;
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockImplementation(async (sql, opts) => {
      const text = String(sql);
      executed.push(text);
      const replacements = (opts as { replacements?: { tableName?: string; columnName?: string } } | undefined)
        ?.replacements;
      if (text.includes('pg_catalog.format_type')) {
        if (replacements?.tableName === 'orders' || replacements?.tableName === 'tags') {
          return [{ dataType: 'bigint' }] as never;
        }
        return (throughCreated ? [{ dataType: 'bigint' }] : []) as never;
      }
      if (text.includes('SELECT c.relkind AS kind')) {
        if (replacements?.tableName === 'orders_tags') {
          return (throughCreated ? [{ kind: 'r' }] : []) as never;
        }
        return [{ kind: 'r' }] as never;
      }
      if (text.startsWith('CREATE TABLE ')) {
        throughCreated = true;
      }
      return [] as never;
    });

    await ds.collectionManager.ensureJoinTable(
      'orders',
      {
        through: 'orders_tags',
        foreignKey: 'orderId',
        otherKey: 'tagId',
        sourceKey: 'id',
        targetKey: 'id',
        target: 'tags',
      },
      {} as never,
    );

    expect(executed.some((q) => q.startsWith('CREATE TABLE "public"."orders_tags"'))).toBe(true);
    expect(executed.some((q) => q.startsWith('CREATE INDEX '))).toBe(true);
    expect(executed.filter((q) => q.includes('FOREIGN KEY'))).toHaveLength(2);
  });

  it('replaces an existing foreign key constraint when updating onDelete/onUpdate while preserving unspecified actions', async () => {
    const ds = createDataSource({ name: 'pg-fk-update' });
    ds.collectionManager.defineCollection({
      name: 'orders',
      tableName: 'orders',
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    });
    ds.collectionManager.defineCollection({
      name: 'order_items',
      tableName: 'order_items',
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true },
        { name: 'orderId', type: 'bigInt' },
      ],
    });

    const executed: string[] = [];
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockImplementation(async (sql) => {
      const text = String(sql);
      executed.push(text);
      if (text.includes('SELECT c.relkind AS kind')) return [{ kind: 'r' }] as never;
      if (text.includes('pg_catalog.format_type')) return [{ dataType: 'bigint' }] as never;
      if (text.includes('FROM pg_catalog.pg_constraint')) {
        return [
          {
            constraintName: 'fk_existing_order',
            targetSchema: 'public',
            targetTable: 'orders',
            targetColumn: 'id',
            deleteAction: 'n',
            updateAction: 'r',
            columnCount: 1,
          },
        ] as never;
      }
      return [] as never;
    });

    await expect(
      ds.collectionManager.ensureForeignKey(
        'order_items',
        { foreignKey: 'orderId', targetKey: 'id', target: 'orders', onDelete: 'CASCADE' },
        {} as never,
      ),
    ).rejects.toThrow('Conflicting foreign key exists');

    await ds.collectionManager.ensureForeignKey(
      'order_items',
      { foreignKey: 'orderId', targetKey: 'id', target: 'orders', onDelete: 'CASCADE', replaceActions: true },
      {} as never,
    );

    expect(executed.some((q) => q === 'ALTER TABLE "public"."order_items" DROP CONSTRAINT "fk_existing_order"')).toBe(
      true,
    );
    expect(
      executed.some((q) => q.includes('ADD CONSTRAINT') && q.includes('ON DELETE CASCADE ON UPDATE RESTRICT')),
    ).toBe(true);
  });

  it('rolls back replaced and newly added collections if defineCollection throws during batch replacement', () => {
    const ds = createDataSource({ name: 'pg-rollback' });
    ds.collectionManager.defineCollection({
      name: 'orders',
      tableName: 'orders',
      title: 'Original Orders',
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    });

    const originalDefine = ds.collectionManager.defineCollection.bind(ds.collectionManager);
    vi.spyOn(ds.collectionManager, 'defineCollection').mockImplementation((options) => {
      if (options.name === 'broken') {
        throw new Error('Invalid saved relation');
      }
      return originalDefine(options);
    });

    expect(() =>
      ds.collectionManager.replaceCollections([
        {
          name: 'orders',
          tableName: 'orders',
          title: 'Updated Orders',
          fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
        },
        {
          name: 'fresh_table',
          tableName: 'fresh_table',
          fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
        },
        {
          name: 'broken',
          tableName: 'broken',
          fields: [],
        },
      ]),
    ).toThrow('Invalid saved relation');

    expect(ds.collectionManager.hasCollection('orders')).toBe(true);
    expect(ds.collectionManager.getCollection('orders')?.options.title).toBe('Original Orders');
    expect(ds.collectionManager.hasCollection('fresh_table')).toBe(false);
  });

  it('queues tablesLoaded behind selectionChanged and does not resurrect deselected tables on HA peers', async () => {
    const { plugin, ds, dataSourcesRepo } = createPluginHarness();
    await plugin.load();
    ds.options = {
      ...ds.options,
      addAllCollections: false,
      selectedCollections: ['orders'],
    };

    let releaseReconcile: (() => void) | undefined;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    const order: string[] = [];

    dataSourcesRepo.findOne.mockImplementation(async () => ({
      get: (field: string) =>
        field === 'options'
          ? {
              host: '127.0.0.1',
              port: 5432,
              database: 'sales',
              username: 'postgres',
              password: 'secret-password',
              ssl: true,
              sslCa: '-----BEGIN CERTIFICATE-----',
              addAllCollections: false,
              selectedCollections: [],
            }
          : undefined,
      loadLocalData: vi.fn().mockResolvedValue({}),
    }));
    vi.spyOn(ds.introspector, 'getTables').mockImplementation(async () => {
      order.push('getTables');
      await reconcileGate;
      return ['orders'];
    });
    const prepareSpy = vi.spyOn(ds, 'prepareTables').mockImplementation(async (tables) => {
      order.push(`prepare:${tables.join(',')}`);
      return tables.map((name) => ({
        name,
        tableName: name,
        fields: [{ name: 'id', type: 'integer', primaryKey: true }],
      }));
    });

    const selectionPromise = plugin.handleSyncMessage({
      type: 'selectionChanged',
      dataSourceKey: 'pg-ext',
    });
    const loadedPromise = plugin.handleSyncMessage({
      type: 'tablesLoaded',
      dataSourceKey: 'pg-ext',
      tableNames: ['orders'],
    });

    await Promise.resolve();
    releaseReconcile?.();
    await Promise.all([selectionPromise, loadedPromise]);

    expect(ds.collectionManager.hasCollection('orders')).toBe(false);
    expect(prepareSpy).toHaveBeenCalledWith([], {});
    expect(order).toEqual(['getTables', 'prepare:']);
  });

  it('preserves selectedCollections on v1 edit when __postgresPreserveSelection is set while allowing v2 clear-all', async () => {
    const ds = createDataSource({ name: 'pg-v1-preserve', addAllCollections: false, selectedCollections: ['orders'] });
    vi.spyOn(ds, 'prepareTables').mockResolvedValue([]);
    vi.spyOn(ds, 'close').mockResolvedValue(undefined);

    const v1Params = {
      values: {
        __postgresPreserveSelection: true,
        collections: [],
        options: {
          addAllCollections: false,
          selectedCollections: ['orders'],
        },
      },
    };
    await ds.loadTables(
      { action: { resourceName: 'dataSources', actionName: 'update', params: v1Params } } as never,
      [],
    );
    expect('__postgresPreserveSelection' in v1Params.values).toBe(false);
    expect(v1Params.values.options.selectedCollections).toEqual(['orders']);

    const v2Params = {
      values: {
        collections: [],
        options: {
          addAllCollections: false,
          selectedCollections: ['orders'],
        },
      },
    };
    await ds.loadTables(
      { action: { resourceName: 'dataSources', actionName: 'update', params: v2Params } } as never,
      [],
    );
    expect(v2Params.values.options.selectedCollections).toEqual([]);
  });

  it('registers and persists companion array fields for m2m_array, validates view/join-table DDL, and isolates destroy cleanup & pool lifecycle', async () => {
    const { plugin, ds, app, middlewares, fieldsRepo, dataSourcesRepo, dbEvents } = createPluginHarness();
    const createFieldSpy = vi.fn().mockResolvedValue(undefined);
    (fieldsRepo as Record<string, unknown>).create = createFieldSpy;
    ds.collectionManager.defineCollection({
      name: 'tags',
      tableName: 'tags',
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    });

    await plugin.beforeLoad();
    await plugin.load();
    const schemaMiddleware = middlewares[1];

    // 1. m2m_array creates & binds companion foreignKey field in memory and persists it to dataSourcesFields.
    vi.spyOn(ds.collectionManager, 'ensureForeignKeyArray').mockResolvedValue(undefined);
    vi.spyOn(ds.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
      cb: (tx: unknown) => Promise<unknown>,
    ) => cb({})) as never);
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockResolvedValue([] as never);

    const arrayInput: Record<string, unknown> = {
      name: 'tagRefs',
      interface: 'm2m_array',
      target: 'tags',
    };
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSourcesCollections.fields',
          actionName: 'create',
          params: { associatedIndex: 'pg-ext.orders', values: arrayInput },
        },
        db: app.db,
      },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(ds.collectionManager.getCollection('orders')?.getField('tagRefId')?.options).toMatchObject({
      name: 'tagRefId',
      type: 'set',
      dataType: 'array',
      elementType: 'bigInt',
      isForeignKey: true,
    });
    expect(createFieldSpy).toHaveBeenCalledWith({
      values: expect.objectContaining({
        name: 'tagRefId',
        collectionName: 'orders',
        dataSourceKey: 'pg-ext',
        type: 'set',
        dataType: 'array',
        elementType: 'bigInt',
      }),
    });

    // 2. DDL validations: ensureForeignKey rejects view target before ADD COLUMN; ensureJoinTable rejects SET NULL & tableName collision; ensureForeignKeyArray rejects incompatible scalar column.
    const ddlDs = createDataSource({ name: 'pg-ddl-guards' });
    ddlDs.collectionManager.defineCollection({
      name: 'orders',
      tableName: 'pg_orders',
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    });
    ddlDs.collectionManager.defineCollection({
      name: 'tags',
      tableName: 'tags',
      fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
    });
    const ddlExecuted: string[] = [];
    vi.spyOn(ddlDs.collectionManager.db.sequelize, 'query').mockImplementation(async (sql, opts) => {
      const text = String(sql);
      ddlExecuted.push(text);
      const replacements = (opts as { replacements?: { tableName?: string; columnName?: string } } | undefined)
        ?.replacements;
      if (text.includes('SELECT c.relkind AS kind')) {
        if (replacements?.tableName === 'order_view') return [{ kind: 'v' }] as never;
        if (replacements?.tableName === 'orders_tags_new') return [] as never;
        return [{ kind: 'r' }] as never;
      }
      if (text.includes('pg_catalog.format_type')) {
        if (replacements?.columnName === 'badScalar') return [{ dataType: 'character varying(255)' }] as never;
        return [{ dataType: 'bigint' }] as never;
      }
      return [] as never;
    });

    await expect(
      ddlDs.collectionManager.ensureForeignKey(
        'orders',
        { foreignKey: 'viewId', targetKey: 'id', target: 'order_view' },
        {} as never,
      ),
    ).rejects.toThrow('This collection is read-only');
    expect(ddlExecuted.some((q) => q.includes('ADD COLUMN'))).toBe(false);

    await expect(
      ddlDs.collectionManager.ensureJoinTable(
        'orders',
        {
          through: 'pg_orders',
          foreignKey: 'orderId',
          otherKey: 'tagId',
          sourceKey: 'id',
          targetKey: 'id',
          target: 'tags',
        },
        {} as never,
      ),
    ).rejects.toThrow('Join table pg_orders cannot match source or target collection');

    await expect(
      ddlDs.collectionManager.ensureJoinTable(
        'orders',
        {
          through: 'orders_tags_new',
          foreignKey: 'orderId',
          otherKey: 'tagId',
          sourceKey: 'id',
          targetKey: 'id',
          target: 'tags',
          onDelete: 'SET NULL',
        },
        {} as never,
      ),
    ).rejects.toThrow('Invalid PostgreSQL foreign key action');

    await expect(
      ddlDs.collectionManager.ensureForeignKeyArray(
        'orders',
        { foreignKey: 'badScalar', targetKey: 'id', target: 'tags' },
        {} as never,
      ),
    ).rejects.toThrow('Foreign key orders.badScalar has incompatible PostgreSQL type character varying(255)');

    // 3. collections:destroy logs warning instead of rolling back DROP TABLE if fieldsRepo.destroy throws post-commit.
    vi.spyOn(ds.collectionManager, 'dropTable').mockResolvedValue(undefined);
    vi.spyOn(ds, 'removeSelectedTables').mockResolvedValue(false);
    fieldsRepo.destroy.mockRejectedValueOnce(new Error('transient main-db timeout'));
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: { associatedIndex: 'pg-ext', filterByTk: 'tags' },
        },
      },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(ds.collectionManager.hasCollection('tags')).toBe(false);
    expect(app.log.warn).toHaveBeenCalled();

    // 4. Pool lifecycle: failed reload keeps original source tracked; same-key replacement is not closed by stale afterCommit or late HA message; close errors in afterCommit are caught.
    const failingReload = createDataSource({ name: 'pg-ext' });
    vi.spyOn(failingReload, 'load').mockRejectedValueOnce(new Error('bad password'));
    await expect(app.dataSourceManager.add(failingReload, { reuseDB: true })).rejects.toThrow('bad password');

    const originalCloseSpy = vi.spyOn(ds, 'close').mockRejectedValueOnce(new Error('socket already closed'));
    const destroyListeners = dbEvents.get('dataSources.afterDestroy') || [];
    app.dataSourceManager.dataSources.delete('pg-ext');

    let commitCallback: (() => Promise<void> | void) | undefined;
    await destroyListeners[0](
      { get: (field: string) => (field === 'type' ? DATA_SOURCE_TYPE : field === 'key' ? 'pg-ext' : undefined) },
      {
        transaction: {
          afterCommit: (fn: () => Promise<void> | void) => {
            commitCallback = fn;
          },
        },
      },
    );

    const replacement = createDataSource({ name: 'pg-ext' });
    const replacementCloseSpy = vi.spyOn(replacement, 'close').mockResolvedValue(undefined);
    vi.spyOn(replacement, 'load').mockResolvedValueOnce(undefined);
    await app.dataSourceManager.add(replacement);

    await expect(Promise.resolve(commitCallback?.())).resolves.toBeUndefined();
    expect(originalCloseSpy).toHaveBeenCalledOnce();
    expect(replacementCloseSpy).not.toHaveBeenCalled();
    expect(app.dataSourceManager.get('pg-ext')).toBe(replacement);

    dataSourcesRepo.findOne.mockResolvedValueOnce({ key: 'pg-ext' });
    await plugin.handleSyncMessage({ type: 'dataSourceRemoved', dataSourceKey: 'pg-ext' });
    expect(replacementCloseSpy).not.toHaveBeenCalled();
  });
});
