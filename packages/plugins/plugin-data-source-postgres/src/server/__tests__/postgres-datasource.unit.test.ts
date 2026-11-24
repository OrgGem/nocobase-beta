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

  it('supports direct loadTables calls without ctx.action or params and preserves reusedDatabase', async () => {
    const ds = createDataSource({ selectedCollections: [], autoDiscover: false });
    vi.spyOn(ds.collectionManager.db.sequelize, 'authenticate').mockResolvedValue(undefined);
    vi.spyOn(ds.introspector, 'getTables').mockResolvedValue(['orders']);
    vi.spyOn(ds, 'prepareTables').mockImplementation(async (tables) =>
      tables.map((name) => ({
        name,
        tableName: name,
        introspected: true,
        fields: [{ name: 'id', type: 'bigInt', primaryKey: true }],
      })),
    );
    const closeSpy = vi.spyOn(ds, 'close');

    await ds.load();
    expect(ds.collectionManager.getCollections()).toHaveLength(0);

    await ds.loadTables({} as never, ['orders']);
    expect(ds.collectionManager.getCollections().map((c) => c.name)).toEqual(['orders']);
    expect(closeSpy).not.toHaveBeenCalled();

    await ds.loadTables({ action: {} } as never, ['orders']);
    expect(ds.collectionManager.getCollections().map((c) => c.name)).toEqual(['orders']);

    const sharedDb = new Database({
      dialect: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'sales',
      username: 'postgres',
      logging: false,
    });
    try {
      const reused = new PostgresDataSource({
        name: 'pg-reused',
        databaseInstance: sharedDb,
        addAllCollections: false,
        autoDiscover: false,
      });
      vi.spyOn(reused, 'prepareTables').mockResolvedValue([
        { name: 'orders', tableName: 'orders', introspected: true, fields: [] },
      ]);
      const sharedCloseSpy = vi.spyOn(sharedDb, 'close');

      await reused.loadTables(undefined as never, ['orders']);
      expect(reused.collectionManager.getCollections().map((c) => c.name)).toEqual(['orders']);
      expect(sharedCloseSpy).not.toHaveBeenCalled();
    } finally {
      await sharedDb.close();
    }
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

  it('filters collections consistently across DROP TABLE and metadata destroy for filterByTk, filter, and ACL scope', async () => {
    const { plugin, ds, middlewares, fieldsRepo, collectionsRepo, sendSyncMessage } = createPluginHarness();
    ds.collectionManager.defineCollection({
      name: 'invoices',
      tableName: 'invoices',
      fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    });
    await plugin.load();
    const schemaMiddleware = middlewares[1];

    vi.spyOn(ds.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
      cb: (tx: unknown) => Promise<unknown>,
    ) => cb({})) as never);
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockResolvedValue([] as never);
    const dropSpy = vi.spyOn(ds.collectionManager, 'dropTable').mockResolvedValue(undefined);
    vi.spyOn(ds, 'removeSelectedTables').mockResolvedValue(false);

    // 1. Non-matching filter with filterByTk must drop nothing and skip next().
    const nextUnmatched = vi.fn().mockResolvedValue(undefined);
    const unmatchedCtx: Record<string, unknown> = {
      action: {
        resourceName: 'dataSources.collections',
        actionName: 'destroy',
        params: { associatedIndex: 'pg-ext', filterByTk: 'orders', filter: { name: 'invoices' } },
      },
    };
    await schemaMiddleware(unmatchedCtx, nextUnmatched);
    expect(dropSpy).not.toHaveBeenCalled();
    expect(nextUnmatched).not.toHaveBeenCalled();
    expect(ds.collectionManager.hasCollection('orders')).toBe(true);
    expect(unmatchedCtx.body).toBe(true);

    // 2. Partial match via persisted collectionsRepo.find + ACL scope filter drops only the matched table
    // and passes the exact matched names (without filter) to next().
    (collectionsRepo as Record<string, unknown>).find = vi
      .fn()
      .mockResolvedValueOnce([{ get: () => 'orders' }, { get: () => 'invoices' }])
      .mockResolvedValueOnce([{ get: () => 'orders' }]);
    const partialParams: Record<string, unknown> = {
      associatedIndex: 'pg-ext',
      filterByTk: ['orders', 'invoices'],
      filter: { name: { $in: ['orders', 'invoices'] } },
    };
    const nextPartial = vi.fn().mockImplementation(async () => {
      expect(partialParams.filterByTk).toEqual(['orders']);
      expect(partialParams.filter).toBeUndefined();
    });
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: partialParams,
        },
        permission: {
          can: { params: { filter: { name: 'orders' } } },
        },
      },
      nextPartial,
    );
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(dropSpy).toHaveBeenCalledWith('orders', false, expect.anything());
    expect(nextPartial).toHaveBeenCalledOnce();
    expect(fieldsRepo.destroy).toHaveBeenCalledWith({
      filter: { dataSourceKey: 'pg-ext', collectionName: { $in: ['orders'] } },
      individualHooks: false,
      hooks: false,
    });
    expect(ds.collectionManager.hasCollection('orders')).toBe(false);
    expect(ds.collectionManager.hasCollection('invoices')).toBe(true);
    expect(sendSyncMessage).toHaveBeenLastCalledWith({
      type: 'collectionRemoved',
      dataSourceKey: 'pg-ext',
      collectionNames: ['orders'],
    });

    // 3. Filter-only destroy (without filterByTk) resolves matched collections via filter.
    dropSpy.mockClear();
    (collectionsRepo as Record<string, unknown>).find = vi
      .fn()
      .mockResolvedValueOnce([{ get: () => 'invoices' }])
      .mockResolvedValueOnce([{ get: () => 'invoices' }]);
    const nextFilterOnly = vi.fn().mockResolvedValue(undefined);
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: { associatedIndex: 'pg-ext', filter: { name: 'invoices' } },
        },
      },
      nextFilterOnly,
    );
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(dropSpy).toHaveBeenCalledWith('invoices', false, expect.anything());
    expect(nextFilterOnly).toHaveBeenCalledOnce();
    expect(ds.collectionManager.hasCollection('invoices')).toBe(false);

    // 4. Runtime-only collections (not yet persisted in dataSourcesCollections) must bind nested field
    // filters to the SAME field element instead of matching across different fields.
    ds.collectionManager.defineCollection({
      name: 'runtime_audit',
      tableName: 'runtime_audit',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'code', type: 'string' },
      ],
    });

    for (const crossFieldFilter of [
      { 'fields.name': 'code', 'fields.type': 'integer' },
      { $and: [{ 'fields.name': 'code' }, { 'fields.type': 'integer' }] },
      { $and: [{ fields: { name: 'code' } }, { fields: { type: 'integer' } }] },
      { 'fields.name': { $startsWith: 'co', $endWith: 'id' } },
    ]) {
      dropSpy.mockClear();
      (collectionsRepo as Record<string, unknown>).find = vi.fn().mockResolvedValue([]);
      const crossCtx: Record<string, unknown> = {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: { associatedIndex: 'pg-ext', filterByTk: 'runtime_audit', filter: crossFieldFilter },
        },
      };
      const crossNext = vi.fn().mockResolvedValue(undefined);
      await schemaMiddleware(crossCtx, crossNext);
      expect(dropSpy).not.toHaveBeenCalled();
      expect(crossNext).not.toHaveBeenCalled();
      expect(crossCtx.body).toBe(true);
      expect(ds.collectionManager.hasCollection('runtime_audit')).toBe(true);
    }

    // Separate filter vs ACL scope across different fields on runtime_audit must also fail to match,
    // including when both sides contain $or groups or nested fields.$or conditions, and $ne array
    // operands must follow core notIn semantics.
    for (const { filter, scope } of [
      {
        filter: { 'fields.name': 'code' },
        scope: { 'fields.type': 'integer' },
      },
      {
        filter: { $or: [{ 'fields.name': 'code' }, { 'fields.name': 'slug' }] },
        scope: { $or: [{ 'fields.type': 'integer' }, { 'fields.type': 'bigInt' }] },
      },
      {
        filter: { fields: { $or: [{ name: 'code' }, { name: 'slug' }] } },
        scope: { fields: { $or: [{ type: 'integer' }, { type: 'bigInt' }] } },
      },
      {
        filter: { name: { $ne: ['runtime_audit', 'orders'] } },
        scope: undefined,
      },
      {
        filter: { 'fields.name': { $ne: ['id', 'code'] } },
        scope: undefined,
      },
    ]) {
      dropSpy.mockClear();
      (collectionsRepo as Record<string, unknown>).find = vi.fn().mockResolvedValue([]);
      const scopedCrossNext = vi.fn().mockResolvedValue(undefined);
      await schemaMiddleware(
        {
          action: {
            resourceName: 'dataSources.collections',
            actionName: 'destroy',
            params: { associatedIndex: 'pg-ext', filterByTk: 'runtime_audit', filter },
          },
          ...(scope ? { permission: { can: { params: { filter: scope } } } } : {}),
        },
        scopedCrossNext,
      );
      expect(dropSpy).not.toHaveBeenCalled();
      expect(scopedCrossNext).not.toHaveBeenCalled();
      expect(ds.collectionManager.hasCollection('runtime_audit')).toBe(true);
    }

    // Same-field filter + ACL $or groups and $ne exclusion list mismatch DO match runtime_audit and drop it.
    dropSpy.mockClear();
    (collectionsRepo as Record<string, unknown>).find = vi.fn().mockResolvedValue([]);
    const matchedOrAndNeNext = vi.fn().mockResolvedValue(undefined);
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: {
            associatedIndex: 'pg-ext',
            filterByTk: 'runtime_audit',
            filter: {
              $and: [
                { name: { $ne: ['other_table'] } },
                { $or: [{ 'fields.name': 'code' }, { 'fields.name': 'slug' }] },
              ],
            },
          },
        },
        permission: {
          can: { params: { filter: { $or: [{ 'fields.type': 'string' }, { 'fields.type': 'text' }] } } },
        },
      },
      matchedOrAndNeNext,
    );
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(dropSpy).toHaveBeenCalledWith('runtime_audit', false, expect.anything());
    expect(matchedOrAndNeNext).toHaveBeenCalledOnce();
    expect(ds.collectionManager.hasCollection('runtime_audit')).toBe(false);

    // Same-field direct property filter ({ name: 'code', type: 'string' }) also matches and drops runtime_audit.
    ds.collectionManager.defineCollection({
      name: 'runtime_audit',
      tableName: 'runtime_audit',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'code', type: 'string' },
      ],
    });
    dropSpy.mockClear();
    (collectionsRepo as Record<string, unknown>).find = vi.fn().mockResolvedValue([]);
    const matchedRuntimeNext = vi.fn().mockResolvedValue(undefined);
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: {
            associatedIndex: 'pg-ext',
            filterByTk: 'runtime_audit',
            filter: { 'fields.name': 'code', 'fields.type': 'string' },
          },
        },
      },
      matchedRuntimeNext,
    );
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(dropSpy).toHaveBeenCalledWith('runtime_audit', false, expect.anything());
    expect(matchedRuntimeNext).toHaveBeenCalledOnce();
    expect(ds.collectionManager.hasCollection('runtime_audit')).toBe(false);

    // Case-insensitive $notIncludes / $includes / $startsWith / $notStartsWith / $endWith / $notEndWith
    // must match PostgreSQL metadata DB ILIKE/NOT ILIKE semantics so mixed-case runtime tables are never dropped
    // by lowercase exclusion filters while non-matching tables ARE dropped.
    ds.collectionManager.defineCollection({
      name: 'Runtime_Audit',
      tableName: 'Runtime_Audit',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'secretCode', type: 'string' },
      ],
    });
    ds.collectionManager.defineCollection({
      name: 'public_items',
      tableName: 'public_items',
      fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    });

    for (const exclusionCase of [
      { filter: { name: { $notIncludes: 'audit' } }, scope: undefined },
      { filter: { name: { $notIncludes: ['audit', 'temp'] } }, scope: undefined },
      { filter: { name: { $notStartsWith: ['runtime_', 'internal_'] } }, scope: undefined },
      { filter: { name: { $notEndWith: ['_AUDIT', '_LOG'] } }, scope: undefined },
      {
        filter: { name: { $notIncludes: 'temp' } },
        scope: { 'fields.name': { $notIncludes: ['id', 'secret'] } },
      },
      { filter: { 'fields.name': { $notIncludes: null } }, scope: { description: { $notIncludes: 'audit' } } },
    ]) {
      dropSpy.mockClear();
      (collectionsRepo as Record<string, unknown>).find = vi.fn().mockResolvedValue([]);
      const nextExclusion = vi.fn().mockResolvedValue(undefined);
      await schemaMiddleware(
        {
          action: {
            resourceName: 'dataSources.collections',
            actionName: 'destroy',
            params: { associatedIndex: 'pg-ext', filterByTk: 'Runtime_Audit', filter: exclusionCase.filter },
          },
          ...(exclusionCase.scope ? { permission: { can: { params: { filter: exclusionCase.scope } } } } : {}),
        },
        nextExclusion,
      );
      expect(dropSpy).not.toHaveBeenCalled();
      expect(nextExclusion).not.toHaveBeenCalled();
      expect(ds.collectionManager.hasCollection('Runtime_Audit')).toBe(true);
    }

    // Conversely, mixed-case exclusion on filter-only destroy drops only public_items and retains Runtime_Audit,
    // and positive case-insensitive $includes matches Runtime_Audit.
    dropSpy.mockClear();
    (collectionsRepo as Record<string, unknown>).find = vi.fn().mockResolvedValue([]);
    const nextNonAuditOnly = vi.fn().mockResolvedValue(undefined);
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: {
            associatedIndex: 'pg-ext',
            filterByTk: ['Runtime_Audit', 'public_items'],
            filter: { name: { $notIncludes: 'audit' } },
          },
        },
      },
      nextNonAuditOnly,
    );
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(dropSpy).toHaveBeenCalledWith('public_items', false, expect.anything());
    expect(nextNonAuditOnly).toHaveBeenCalledOnce();
    expect(ds.collectionManager.hasCollection('public_items')).toBe(false);
    expect(ds.collectionManager.hasCollection('Runtime_Audit')).toBe(true);

    dropSpy.mockClear();
    (collectionsRepo as Record<string, unknown>).find = vi.fn().mockResolvedValue([]);
    const nextCaseMatched = vi.fn().mockResolvedValue(undefined);
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSources.collections',
          actionName: 'destroy',
          params: {
            associatedIndex: 'pg-ext',
            filterByTk: 'Runtime_Audit',
            filter: { name: { $includes: 'audit' }, 'fields.name': { $startsWith: ['SECRET', 'OTHER'] } },
          },
        },
      },
      nextCaseMatched,
    );
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(dropSpy).toHaveBeenCalledWith('Runtime_Audit', false, expect.anything());
    expect(nextCaseMatched).toHaveBeenCalledOnce();
    expect(ds.collectionManager.hasCollection('Runtime_Audit')).toBe(false);
  });

  it('matches core SQLite metadata LIKE semantics for _ and % so runtime-only tables match persisted results', async () => {
    const sqliteMetaDb = new Database({
      dialect: 'sqlite',
      storage: ':memory:',
      logging: false,
    });
    try {
      sqliteMetaDb.collection({
        name: 'dataSourcesCollections',
        autoGenId: false,
        fields: [
          { name: 'name', type: 'string', primaryKey: true },
          { name: 'dataSourceKey', type: 'string', primaryKey: true },
        ],
      });
      await sqliteMetaDb.sync();
      const sqliteCollectionsRepo = sqliteMetaDb.getRepository('dataSourcesCollections');

      const candidateNames = ['order_items', 'order\\xitems', 'foo%bar', 'foo\\abcbar', 'Plain_Table'];
      for (const name of candidateNames) {
        await sqliteCollectionsRepo.create({ values: { name, dataSourceKey: 'pg-sqlite-meta' } });
      }

      const filtersToVerify = [
        { name: { $includes: 'order_' } },
        { name: { $notIncludes: 'order_' } },
        { name: { $startsWith: 'order_' } },
        { name: { $notStartsWith: 'order_' } },
        { name: { $endWith: '_items' } },
        { name: { $notEndWith: '_items' } },
        { name: { $includes: 'foo%bar' } },
        { name: { $notIncludes: 'foo%bar' } },
        { name: { $includes: ['order_', 'foo%bar'] } },
      ];

      for (const filter of filtersToVerify) {
        // 1. Query real SQLite metadata repository directly via core operators.
        const coreMatchedRows = await sqliteCollectionsRepo.find({
          filter: { $and: [{ dataSourceKey: 'pg-sqlite-meta' }, filter] },
        });
        const coreMatchedNames = coreMatchedRows.map((row) => String(row.get('name'))).sort();

        // 2. Run pre-DROP resolution when all candidate collections exist ONLY at runtime (zero persisted rows).
        const harness = createPluginHarness();
        (harness.app as { db: unknown }).db = {
          sequelize: sqliteMetaDb.sequelize,
          getRepository: (repoName: string) => {
            if (repoName === 'dataSourcesCollections') {
              return { find: vi.fn().mockResolvedValue([]) };
            }
            if (repoName === 'dataSourcesFields') return harness.fieldsRepo;
            return harness.dataSourcesRepo;
          },
          on: () => undefined,
        };
        for (const existing of [...harness.ds.collectionManager.getCollections()]) {
          harness.ds.collectionManager.removeCollection(existing.name);
        }
        for (const name of candidateNames) {
          harness.ds.collectionManager.defineCollection({
            name,
            tableName: name,
            fields: [{ name: 'id', type: 'integer', primaryKey: true }],
          });
        }
        vi.spyOn(harness.ds.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
          cb: (tx: unknown) => Promise<unknown>,
        ) => cb({})) as never);
        vi.spyOn(harness.ds.collectionManager.db.sequelize, 'query').mockResolvedValue([] as never);
        const droppedRuntime: string[] = [];
        vi.spyOn(harness.ds.collectionManager, 'dropTable').mockImplementation(async (name) => {
          droppedRuntime.push(name);
        });
        vi.spyOn(harness.ds, 'removeSelectedTables').mockResolvedValue(false);

        await harness.plugin.load();
        const destroyMiddleware = harness.middlewares[1];
        await destroyMiddleware(
          {
            action: {
              resourceName: 'dataSources.collections',
              actionName: 'destroy',
              params: { associatedIndex: 'pg-ext', filter },
            },
          },
          vi.fn().mockResolvedValue(undefined),
        );

        expect(droppedRuntime.sort(), `SQLite parity mismatch for filter ${JSON.stringify(filter)}`).toEqual(
          coreMatchedNames,
        );
      }

      // Specifically confirm `order_items` is NOT matched by `{ name: { $includes: 'order_' } }` on SQLite,
      // whereas on PostgreSQL metadata DB (`ILIKE` with default `\` escape) `order_items` IS matched.
      const pgHarness = createPluginHarness();
      (pgHarness.app.db as Record<string, unknown>).sequelize = { getDialect: () => 'postgres' };
      (pgHarness.collectionsRepo as Record<string, unknown>).find = vi.fn().mockResolvedValue([]);
      pgHarness.ds.collectionManager.defineCollection({
        name: 'order_items',
        tableName: 'order_items',
        fields: [{ name: 'id', type: 'integer', primaryKey: true }],
      });
      pgHarness.ds.collectionManager.defineCollection({
        name: 'orderxitems',
        tableName: 'orderxitems',
        fields: [{ name: 'id', type: 'integer', primaryKey: true }],
      });
      vi.spyOn(pgHarness.ds.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
        cb: (tx: unknown) => Promise<unknown>,
      ) => cb({})) as never);
      vi.spyOn(pgHarness.ds.collectionManager.db.sequelize, 'query').mockResolvedValue([] as never);
      const pgDropped: string[] = [];
      vi.spyOn(pgHarness.ds.collectionManager, 'dropTable').mockImplementation(async (name) => {
        pgDropped.push(name);
      });
      vi.spyOn(pgHarness.ds, 'removeSelectedTables').mockResolvedValue(false);
      await pgHarness.plugin.load();
      await pgHarness.middlewares[1](
        {
          action: {
            resourceName: 'dataSources.collections',
            actionName: 'destroy',
            params: { associatedIndex: 'pg-ext', filter: { name: { $includes: 'order_' } } },
          },
        },
        vi.fn().mockResolvedValue(undefined),
      );
      expect(pgDropped).toEqual(['order_items']);
    } finally {
      await sqliteMetaDb.close();
    }
  });

  it('emits valid PostgreSQL ARRAY literals for ARRAY columns while keeping JSON encoding for JSON/JSONB', async () => {
    const ds = createDataSource({ name: 'pg-array-defaults' });
    ds.collectionManager.defineCollection({
      name: 'items',
      tableName: 'items',
      fields: [
        { name: 'id', type: 'bigInt', primaryKey: true },
        { name: 'tags', type: 'array', dataType: 'array', elementType: 'integer' },
        { name: 'flags', type: 'array', dataType: 'array', elementType: 'boolean' },
        { name: 'meta', type: 'jsonb' },
      ],
    });

    const executed: string[] = [];
    vi.spyOn(ds.collectionManager.db.sequelize, 'query').mockImplementation(async (sql, opts) => {
      const text = String(sql);
      executed.push(text);
      const colName = (opts as { replacements?: { columnName?: string } } | undefined)?.replacements?.columnName;
      if (text.includes('pg_catalog.format_type')) {
        if (colName === 'tags') return [{ dataType: 'integer[]' }] as never;
        if (colName === 'flags') return [{ dataType: 'boolean[]' }] as never;
        if (colName === 'meta') return [{ dataType: 'jsonb' }] as never;
      }
      return [] as never;
    });

    await ds.collectionManager.addField(
      'items',
      { name: 'scores', type: 'array', elementType: 'integer', defaultValue: [1, 2] },
      {} as never,
    );
    expect(executed[executed.length - 1]).toBe(
      'ALTER TABLE "public"."items" ADD COLUMN "scores" INTEGER[] DEFAULT ARRAY[1, 2]::INTEGER[]',
    );

    await ds.collectionManager.addField(
      'items',
      { name: 'labels', type: 'array', dataType: 'array', elementType: 'text', defaultValue: [] },
      {} as never,
    );
    expect(executed[executed.length - 1]).toBe(
      'ALTER TABLE "public"."items" ADD COLUMN "labels" TEXT[] DEFAULT ARRAY[]::TEXT[]',
    );

    await ds.collectionManager.addField(
      'items',
      { name: 'json_arr', type: 'array', defaultValue: [1, 2] },
      {} as never,
    );
    expect(executed[executed.length - 1]).toBe(
      `ALTER TABLE "public"."items" ADD COLUMN "json_arr" JSONB DEFAULT '[1,2]'`,
    );

    await ds.collectionManager.updateField('items', 'tags', { defaultValue: [3, 4] }, {} as never);
    expect(executed[executed.length - 1]).toBe(
      'ALTER TABLE "public"."items" ALTER COLUMN "tags" SET DEFAULT ARRAY[3, 4]::integer[]',
    );

    await ds.collectionManager.updateField('items', 'flags', { defaultValue: [true, false] }, {} as never);
    expect(executed[executed.length - 1]).toBe(
      'ALTER TABLE "public"."items" ALTER COLUMN "flags" SET DEFAULT ARRAY[TRUE, FALSE]::boolean[]',
    );

    await ds.collectionManager.updateField('items', 'meta', { defaultValue: { a: 1 } }, {} as never);
    expect(executed[executed.length - 1]).toBe(
      `ALTER TABLE "public"."items" ALTER COLUMN "meta" SET DEFAULT '{"a":1}'`,
    );

    await expect(
      ds.collectionManager.updateField('items', 'tags', { defaultValue: ['not-an-int'] }, {} as never),
    ).rejects.toThrow('Unsupported PostgreSQL default value');
  });

  it('persists dataType: array when elementType is given and keeps model ARRAY typing across write, reload, and read', async () => {
    const { plugin, ds, middlewares } = createPluginHarness();
    await plugin.load();
    const schemaMiddleware = middlewares[1];
    const itemsCollection = ds.collectionManager.defineCollection({
      name: 'items',
      tableName: 'items',
      autoGenId: false,
      timestamps: false,
      fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    });

    const capturedInserts: Array<{ sql: string; bind?: unknown[] }> = [];
    const storedRows = new Map<number, { id: number; scores: number[] }>();
    const bindMockQuery = (targetDs: PostgresDataSource) => {
      const fakeTx = {
        commit: async () => undefined,
        rollback: async () => undefined,
        afterCommit: () => undefined,
      };
      vi.spyOn(targetDs.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
        cbOrOpts?: unknown,
        maybeCb?: unknown,
      ) => {
        const cb = typeof cbOrOpts === 'function' ? cbOrOpts : typeof maybeCb === 'function' ? maybeCb : null;
        return cb ? await (cb as (tx: unknown) => Promise<unknown>)(fakeTx) : fakeTx;
      }) as never);
      vi.spyOn(targetDs.collectionManager.db.sequelize, 'query').mockImplementation(async (sql, opts) => {
        const sqlObj = typeof sql === 'object' && sql !== null ? (sql as { query?: unknown; bind?: unknown[] }) : null;
        const text = sqlObj ? String(sqlObj.query ?? '') : String(sql);
        const queryOpts = (opts || {}) as {
          type?: string;
          bind?: unknown[];
          instance?: { isNewRecord?: boolean; dataValues?: Record<string, unknown> };
          model?: { bulkBuild: (rows: unknown[], buildOpts: Record<string, unknown>) => unknown[] };
          raw?: boolean;
          attributes?: unknown[];
          originalAttributes?: unknown[];
        };
        const bind = sqlObj?.bind ?? queryOpts.bind;
        if (text.startsWith('INSERT INTO') || queryOpts.type === 'INSERT') {
          capturedInserts.push({ sql: text, bind });
          // Reject JSONB-encoded array strings on an INTEGER[] column just like PostgreSQL does.
          if (
            text.includes(`'[`) ||
            (Array.isArray(bind) && bind.some((item) => typeof item === 'string' && item.startsWith('[')))
          ) {
            throw new Error('malformed array literal: JSON string passed to integer[]');
          }
          if (Array.isArray(bind) && bind.length >= 2 && Array.isArray(bind[1])) {
            const id = Number(bind[0]);
            const nums = bind[1].map((item) => Number(item));
            storedRows.set(id, { id, scores: nums });
          } else {
            const arrayMatch = text.match(/VALUES\s*\((\d+),\s*ARRAY\[([^\]]+)\]/);
            if (arrayMatch) {
              const id = Number(arrayMatch[1]);
              const nums = arrayMatch[2].split(',').map((part) => Number(part.trim()));
              storedRows.set(id, { id, scores: nums });
            }
          }
          return [queryOpts.instance, 1] as never;
        }
        if (text.startsWith('SELECT') && text.includes('FROM "public"."items"')) {
          const latest = [...storedRows.values()][storedRows.size - 1];
          const rawRows = latest ? [latest] : [];
          if (queryOpts.model && !queryOpts.raw) {
            return queryOpts.model.bulkBuild(rawRows, {
              isNewRecord: false,
              raw: true,
              attributes: queryOpts.originalAttributes || queryOpts.attributes,
            }) as never;
          }
          return rawRows as never;
        }
        return [] as never;
      });
    };
    bindMockQuery(ds);

    // 1. Add array field via schema action without explicit dataType.
    const fieldValues: Record<string, unknown> = {
      name: 'scores',
      type: 'array',
      elementType: 'integer',
      defaultValue: [1, 2],
    };
    await schemaMiddleware(
      {
        action: {
          resourceName: 'dataSourcesCollections.fields',
          actionName: 'create',
          params: { associatedIndex: 'pg-ext.items', values: fieldValues },
        },
      },
      async () => {
        itemsCollection.setField('scores', fieldValues);
      },
    );

    expect(fieldValues.dataType).toBe('array');
    expect(itemsCollection.getField('scores')?.options.dataType).toBe('array');
    expect((itemsCollection.model.rawAttributes.scores.type as { key?: string }).key).toBe('ARRAY');

    // 2. Writing via Sequelize repository must serialize ARRAY column cleanly, not JSONB string '[3,9]'.
    await itemsCollection.repository.create({ values: { id: 1, scores: [9, 3] } });
    const firstInsert = capturedInserts[capturedInserts.length - 1];
    expect(
      firstInsert.sql.includes('ARRAY[3,9]') ||
        (Array.isArray(firstInsert.bind?.[1]) && firstInsert.bind?.[1].join(',') === '3,9'),
    ).toBe(true);
    expect(storedRows.get(1)?.scores).toEqual([3, 9]);

    // 3. Reload into a fresh PostgresDataSource using persisted metadata (even if dataType were omitted in legacy JSON).
    const persistedLocalData = {
      items: {
        name: 'items',
        tableName: 'items',
        autoGenId: false,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'scores', type: 'array', dataType: fieldValues.dataType, elementType: 'integer' },
        ],
      },
    };
    const reloaded = createDataSource({ name: 'pg-ext-reloaded' });
    vi.spyOn(reloaded.collectionManager.db.sequelize, 'authenticate').mockResolvedValue(undefined);
    vi.spyOn(reloaded.introspector, 'getTables').mockResolvedValue(['items']);
    vi.spyOn(reloaded, 'prepareTables').mockImplementation(async () => [
      {
        name: 'items',
        tableName: 'items',
        autoGenId: false,
        timestamps: false,
        introspected: true,
        fields: persistedLocalData.items.fields.map((f) => ({ ...f })),
      },
    ]);
    await reloaded.load({ localData: persistedLocalData });
    bindMockQuery(reloaded);

    const reloadedItems = reloaded.collectionManager.getCollection('items');
    expect(reloadedItems.getField('scores')?.options.dataType).toBe('array');
    expect((reloadedItems.model.rawAttributes.scores.type as { key?: string }).key).toBe('ARRAY');

    await reloadedItems.repository.create({ values: { id: 2, scores: [7, 1] } });
    const secondInsert = capturedInserts[capturedInserts.length - 1];
    expect(
      secondInsert.sql.includes('ARRAY[1,7]') ||
        (Array.isArray(secondInsert.bind?.[1]) && secondInsert.bind?.[1].join(',') === '1,7'),
    ).toBe(true);
    expect(storedRows.get(2)?.scores).toEqual([1, 7]);

    const loadedRecord = await reloadedItems.repository.findOne({ filterByTk: 2 });
    expect(loadedRecord?.get('scores')).toEqual([1, 7]);

    // Also verify buildField normalizes legacy field metadata defined without dataType when not backed by JSON/JSONB.
    const legacyCollection = reloaded.collectionManager.defineCollection({
      name: 'legacy_items',
      tableName: 'legacy_items',
      fields: [{ name: 'nums', type: 'array', elementType: 'integer' }],
    });
    expect(legacyCollection.getField('nums')?.options.dataType).toBe('array');
    expect((legacyCollection.model.rawAttributes.nums.type as { key?: string }).key).toBe('ARRAY');

    // Legacy field metadata saved as { type: 'array', elementType: 'string' } without dataType over an
    // existing PostgreSQL JSONB column must keep JSONB typing through real prepareTables() reload & writes,
    // while a sibling physical ARRAY column in the same table resolves to ARRAY.
    const legacyHarness = createPluginHarness();
    await legacyHarness.plugin.load();
    const legacyMiddleware = legacyHarness.middlewares[1];
    const legacyDs = legacyHarness.ds;
    vi.spyOn(legacyDs.collectionManager.db.sequelize.getQueryInterface(), 'describeTable').mockResolvedValue({
      id: { type: 'INTEGER', allowNull: false, defaultValue: '', primaryKey: true },
      tags: { type: 'JSONB', allowNull: true, defaultValue: null, primaryKey: false },
      scores: { type: 'ARRAY', allowNull: true, defaultValue: null, primaryKey: false },
    } as never);
    vi.spyOn(legacyDs.introspector, 'getTableConstraints').mockResolvedValue([]);
    vi.spyOn(legacyDs.collectionManager, 'getTableKinds').mockResolvedValue(new Map([['legacy_orders', 'r']]));
    const executedDefaults: string[] = [];
    const legacyInserts: Array<{ sql: string; bind?: unknown[] }> = [];
    const legacyRows = new Map<number, { id: number; tags: unknown; scores: number[] }>();
    const legacyTx = {
      commit: async () => undefined,
      rollback: async () => undefined,
      afterCommit: () => undefined,
    };
    vi.spyOn(legacyDs.collectionManager.db.sequelize, 'transaction').mockImplementation((async (
      cbOrOpts?: unknown,
      maybeCb?: unknown,
    ) => {
      const cb = typeof cbOrOpts === 'function' ? cbOrOpts : typeof maybeCb === 'function' ? maybeCb : null;
      return cb ? await (cb as (tx: unknown) => Promise<unknown>)(legacyTx) : legacyTx;
    }) as never);
    vi.spyOn(legacyDs.collectionManager.db.sequelize, 'query').mockImplementation(async (sql, opts) => {
      const sqlObj = typeof sql === 'object' && sql !== null ? (sql as { query?: unknown; bind?: unknown[] }) : null;
      const text = sqlObj ? String(sqlObj.query ?? '') : String(sql);
      const queryOpts = (opts || {}) as {
        type?: string;
        bind?: unknown[];
        replacements?: { columnName?: string };
        instance?: unknown;
        model?: { bulkBuild: (rows: unknown[], buildOpts: Record<string, unknown>) => unknown[] };
        raw?: boolean;
        attributes?: unknown[];
        originalAttributes?: unknown[];
      };
      if (text.includes('information_schema.element_types')) {
        return [{ column_name: 'scores', element_type: 'integer' }] as never;
      }
      if (text.includes('pg_catalog.format_type')) {
        if (queryOpts.replacements?.columnName === 'tags') return [{ dataType: 'jsonb' }] as never;
        if (queryOpts.replacements?.columnName === 'scores') return [{ dataType: 'integer[]' }] as never;
      }
      if (text.startsWith('ALTER TABLE')) {
        executedDefaults.push(text);
        return [] as never;
      }
      if (text.startsWith('INSERT INTO') || queryOpts.type === 'INSERT') {
        const bind = sqlObj?.bind ?? queryOpts.bind;
        legacyInserts.push({ sql: text, bind });
        if (!Array.isArray(bind) || typeof bind[1] !== 'string' || !Array.isArray(bind[2])) {
          throw new Error(`Expected JSONB string bind[1] and ARRAY bind[2], got: ${JSON.stringify(bind)}`);
        }
        legacyRows.set(Number(bind[0]), {
          id: Number(bind[0]),
          tags: JSON.parse(bind[1]),
          scores: bind[2].map((v) => Number(v)),
        });
        return [queryOpts.instance, 1] as never;
      }
      if (text.startsWith('SELECT') && text.includes('FROM "public"."legacy_orders"')) {
        const row = legacyRows.get(1);
        const rawRows = row ? [row] : [];
        if (queryOpts.model && !queryOpts.raw) {
          return queryOpts.model.bulkBuild(rawRows, {
            isNewRecord: false,
            raw: true,
            attributes: queryOpts.originalAttributes || queryOpts.attributes,
          }) as never;
        }
        return rawRows as never;
      }
      return [] as never;
    });

    const prepared = await legacyDs.prepareTables(['legacy_orders'], {
      legacy_orders: {
        name: 'legacy_orders',
        tableName: 'legacy_orders',
        autoGenId: false,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'tags', type: 'array', elementType: 'string' },
          { name: 'scores', type: 'array', elementType: 'integer' },
        ],
      },
    });
    legacyDs.collectionManager.replaceCollections(prepared);

    const legacyOrders = legacyDs.collectionManager.getCollection('legacy_orders');
    expect(legacyOrders.getField('tags')?.options.dataType).toBe('json');
    expect(legacyOrders.getField('tags')?.options.rawType).toBe('JSONB');
    expect((legacyOrders.model.rawAttributes.tags.type as { key?: string }).key).toBe('JSONB');
    expect(legacyOrders.getField('scores')?.options.dataType).toBe('array');
    expect((legacyOrders.model.rawAttributes.scores.type as { key?: string }).key).toBe('ARRAY');

    await legacyOrders.repository.create({ values: { id: 1, tags: ['b', 'a'], scores: [7, 1] } });
    expect(legacyInserts).toHaveLength(1);
    const reloadedLegacy = await legacyOrders.repository.findOne({ filterByTk: 1 });
    expect(reloadedLegacy?.get('tags')).toEqual(['a', 'b']);
    expect(reloadedLegacy?.get('scores')).toEqual([1, 7]);

    // Updating the legacy JSONB-backed field must emit JSON default instead of promoting to ARRAY.
    const updateValues: Record<string, unknown> = { type: 'array', elementType: 'string', defaultValue: ['x', 'y'] };
    await legacyMiddleware(
      {
        action: {
          resourceName: 'dataSourcesCollections.fields',
          actionName: 'update',
          params: { associatedIndex: 'pg-ext.legacy_orders', filterByTk: 'tags', values: updateValues },
        },
      },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(updateValues.dataType).toBeUndefined();
    expect(executedDefaults[executedDefaults.length - 1]).toBe(
      `ALTER TABLE "public"."legacy_orders" ALTER COLUMN "tags" SET DEFAULT '["x","y"]'`,
    );
  });
});
