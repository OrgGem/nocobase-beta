// SPDX-License-Identifier: Apache-2.0

import { Database } from '@nocobase/database';
import { Op } from 'sequelize';
import {
  buildSessionInitSql,
  formatDatabaseOptions,
  formatProbeDatabaseOptions,
  MssqlExternalDataSource,
} from '../data-source/MssqlExternalDataSource';
import { MssqlDialect } from '../dialects/mssql-dialect';

Database.registerDialect(MssqlDialect);

describe('formatDatabaseOptions', () => {
  it('enables ARITHABORT by default (recommended SQL Server session setting)', () => {
    const opts = formatDatabaseOptions({ host: 'localhost', database: 'db' });
    expect(opts.dialectOptions.options.enableArithAbort).toBe(true);
  });

  it('lets a caller override enableArithAbort', () => {
    const opts = formatDatabaseOptions({
      host: 'localhost',
      database: 'db',
      dialectOptions: { options: { enableArithAbort: false } },
    });
    expect(opts.dialectOptions.options.enableArithAbort).toBe(false);
  });

  it('forces useUTC to avoid datetime offset issues', () => {
    const opts = formatDatabaseOptions({ host: 'localhost', database: 'db' });
    expect(opts.dialectOptions.options.useUTC).toBe(true);
  });

  it('maps the encrypt flag into tedious options', () => {
    expect(formatDatabaseOptions({ encrypt: true }).dialectOptions.options.encrypt).toBe(true);
    expect(formatDatabaseOptions({ encrypt: false }).dialectOptions.options.encrypt).toBe(false);
    expect('encrypt' in formatDatabaseOptions({}).dialectOptions.options).toBe(false);
  });

  it('applies sensible pool defaults while allowing overrides', () => {
    const defaults = formatDatabaseOptions({});
    expect(defaults.pool).toMatchObject({ max: 10, min: 2, acquire: 30000, idle: 10000 });

    const custom = formatDatabaseOptions({ pool: { max: 25 } });
    expect(custom.pool.max).toBe(25);
    expect(custom.pool.min).toBe(2);
  });

  it('maps trustServerCertificate, readOnlyIntent, requestTimeout, and runtime options', () => {
    const opts = formatDatabaseOptions({
      trustServerCertificate: false,
      readOnlyIntent: true,
      requestTimeout: 30000,
      fastCount: true,
      deferredJoinThreshold: 500,
    });
    expect(opts.dialectOptions.options.trustServerCertificate).toBe(false);
    expect(opts.dialectOptions.options.readOnlyIntent).toBe(true);
    expect(opts.dialectOptions.options.requestTimeout).toBe(30000);
    expect(opts.mssqlRuntimeOptions).toEqual({ fastCount: true, deferredJoinThreshold: 500 });
  });

  it('logs slow queries exceeding threshold via benchmark logging', () => {
    const warn = vi.fn();
    const opts = formatDatabaseOptions({ slowQueryThresholdMs: 500, logger: { warn } });
    expect(opts.benchmark).toBe(true);
    expect(typeof opts.logging).toBe('function');
    (opts.logging as (sql: string, timing?: number) => void)('SELECT 1', 100);
    expect(warn).not.toHaveBeenCalled();
    (opts.logging as (sql: string, timing?: number) => void)('SELECT * FROM BigTable', 1500);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[MSSQL] Slow query (1500ms)'));
  });

  it('creates lightweight probe options with min=0, max=1, and fast timeouts', () => {
    const probe = formatProbeDatabaseOptions({ host: 'localhost', database: 'db' });
    expect(probe.pool).toMatchObject({ max: 1, min: 0 });
    expect(probe.dialectOptions.options.connectTimeout).toBe(10000);
    expect(probe.dialectOptions.options.requestTimeout).toBe(15000);
  });

  it('maps readUncommitted only to connectionIsolationLevel so explicit write transactions stay READ COMMITTED', () => {
    const opts = formatDatabaseOptions({ readUncommitted: true });
    expect(opts.dialectOptions.options.isolationLevel).toBeUndefined();
    expect(opts.dialectOptions.options.connectionIsolationLevel).toBe(0x01);

    const defaultOpts = formatDatabaseOptions({});
    expect(defaultOpts.dialectOptions.options.isolationLevel).toBeUndefined();
    expect(defaultOpts.dialectOptions.options.connectionIsolationLevel).toBeUndefined();
  });

  it('builds safe session init SQL for lockTimeout only', () => {
    expect(buildSessionInitSql({})).toBe('');
    expect(buildSessionInitSql({ lockTimeout: 0 })).toBe('');
    expect(buildSessionInitSql({ lockTimeout: 5000 })).toBe('SET LOCK_TIMEOUT 5000;');
  });

  it('reuses databaseInstance without stacking session hooks, wiping live optimizations on failure, or leaking duplicate models', async () => {
    const db = new Database({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const addHookSpy = vi.spyOn(db.sequelize, 'addHook');
    const removeHookSpy = vi.spyOn(db.sequelize, 'removeHook');

    const stubIntrospection = (
      ds: MssqlExternalDataSource,
      tables: string[],
      getFields: (tableName: string) => Array<{ name: string; type: string }>,
      options: { ansiCols?: Record<string, string[]>; ftsCols?: Record<string, string[]> } = {},
    ) => {
      vi.spyOn(ds.collectionManager.db.sequelize, 'authenticate').mockResolvedValue(undefined);
      vi.spyOn(ds.collectionManager.db, 'checkVersion').mockResolvedValue(true);
      vi.spyOn(ds.introspector, 'clearCache').mockImplementation(() => undefined);
      vi.spyOn(ds.introspector, 'getTables').mockResolvedValue(tables);
      vi.spyOn(ds.introspector, 'preloadAllColumns').mockResolvedValue(undefined);
      vi.spyOn(ds.introspector, 'preloadAllPrimaryKeys').mockResolvedValue(undefined);
      vi.spyOn(ds.introspector, 'preloadAllIndexes').mockResolvedValue(undefined);
      vi.spyOn(ds.introspector, 'preloadFTSIndexedColumns').mockResolvedValue(undefined);
      vi.spyOn(ds.introspector, 'isAnsiStringColumn').mockImplementation((t, c) =>
        Boolean(options.ansiCols?.[t]?.includes(c)),
      );
      vi.spyOn(ds.introspector, 'hasFTSIndex').mockImplementation((t, c) => Boolean(options.ftsCols?.[t]?.includes(c)));
      vi.spyOn(ds.introspector, 'getCollection').mockImplementation(async ({ tableInfo }) => {
        const tableName = typeof tableInfo === 'string' ? tableInfo : tableInfo.tableName;
        return {
          name: tableName,
          tableName,
          fields: getFields(tableName),
        } as never;
      });
    };

    const ds1 = new MssqlExternalDataSource({
      databaseInstance: db,
      lockTimeout: 3000,
      fastCount: true,
      trustServerCertificate: false,
    });
    stubIntrospection(
      ds1,
      ['orders', 'dropped_tbl'],
      () => [
        { name: 'id', type: 'integer' },
        { name: 'title', type: 'string' },
      ],
      { ansiCols: { orders: ['code'] }, ftsCols: { orders: ['title'] } },
    );
    await ds1.load();
    db.collection({ name: 'manual_local', introspected: false, fields: [{ name: 'id', type: 'integer' }] });

    const runtimeAfterDs1 = (
      db.options as {
        mssqlRuntimeOptions?: {
          fastCount?: boolean;
          isAnsiStringColumn?: (table: string, col: string) => boolean;
        };
      }
    ).mssqlRuntimeOptions;
    expect(runtimeAfterDs1?.fastCount).toBe(true);
    expect(runtimeAfterDs1?.isAnsiStringColumn?.('orders', 'code')).toBe(true);

    // Constructing ds2 and failing ds2.load() must NOT clobber ds1's live runtime options or operators.
    const dsFailed = new MssqlExternalDataSource({
      databaseInstance: db,
      lockTimeout: 9000,
      fastCount: false,
    });
    const runtimeBeforeFailedLoad = (
      db.options as {
        mssqlRuntimeOptions?: {
          fastCount?: boolean;
          isAnsiStringColumn?: (table: string, col: string) => boolean;
        };
      }
    ).mssqlRuntimeOptions;
    expect(runtimeBeforeFailedLoad?.fastCount).toBe(true);
    expect(runtimeBeforeFailedLoad?.isAnsiStringColumn?.('orders', 'code')).toBe(true);

    vi.spyOn(db.sequelize, 'authenticate').mockRejectedValueOnce(new Error('transient refresh outage'));
    await expect(dsFailed.load()).rejects.toThrow('transient refresh outage');
    expect(
      (
        db.options as {
          mssqlRuntimeOptions?: {
            fastCount?: boolean;
            isAnsiStringColumn?: (table: string, col: string) => boolean;
          };
        }
      ).mssqlRuntimeOptions?.isAnsiStringColumn?.('orders', 'code'),
    ).toBe(true);
    const includesOp = db.operators.get('$includes') as (
      v: unknown,
      ctx: Record<string, unknown>,
    ) => Record<symbol, Array<{ val?: string }>>;
    const ftsClauseAfterFailure = includesOp('fast', {
      model: { name: 'orders', tableName: 'orders', rawAttributes: { title: { field: 'title' } } },
      fieldName: 'title',
      fullName: 'title',
    });
    expect(ftsClauseAfterFailure[Op.and]?.[0]?.val).toContain('CONTAINS([orders].[title]');

    // Successful refresh with ds2 updates runtime options, replaces the named hook, prunes dropped_tbl,
    // and replaces orders without duplicating models in Sequelize's modelManager.
    const ds2 = new MssqlExternalDataSource({
      databaseInstance: db,
      lockTimeout: 5000,
      fastCount: false,
      dialectOptions: { options: { trustServerCertificate: false } },
    });
    expect(ds1.collectionManager.db).toBe(db);
    expect(ds2.collectionManager.db).toBe(db);
    expect(ds2.publicOptions().trustServerCertificate).toBe(false);

    stubIntrospection(ds2, ['orders'], () => [
      { name: 'id', type: 'integer' },
      { name: 'title', type: 'string' },
      { name: 'status', type: 'string' },
    ]);

    await ds2.load();

    expect((db.options as { mssqlRuntimeOptions?: { fastCount?: boolean } }).mssqlRuntimeOptions?.fastCount).toBe(
      false,
    );
    expect(removeHookSpy).toHaveBeenCalledWith('afterConnect', 'mssqlSessionInit');
    expect(addHookSpy).toHaveBeenCalledWith('afterConnect', 'mssqlSessionInit', expect.any(Function));
    expect(ds2.introspector.clearCache).toHaveBeenCalledOnce();
    expect(db.hasCollection('dropped_tbl')).toBe(false);
    expect(db.hasCollection('orders')).toBe(true);
    expect(db.hasCollection('manual_local')).toBe(true);

    // Must fix #1: Sequelize modelManager must hold exactly one `orders` model, with the new `status` column.
    const orderModels = db.sequelize.modelManager.models.filter((m) => m.name === 'orders');
    expect(orderModels).toHaveLength(1);
    const resolvedModel = db.sequelize.modelManager.getModel('orders');
    expect(resolvedModel?.rawAttributes).toHaveProperty('status');

    // Re-loading the same table via loadTables() must also replace instead of pushing duplicate models.
    vi.spyOn(ds2, 'prepareTables').mockResolvedValueOnce([
      {
        name: 'orders',
        tableName: 'orders',
        introspected: true,
        fields: [
          { name: 'id', type: 'integer' },
          { name: 'title', type: 'string' },
          { name: 'status', type: 'string' },
          { name: 'priority', type: 'integer' },
        ],
      },
    ]);
    await ds2.loadTables({ action: {} } as never, ['orders']);
    expect(db.sequelize.modelManager.models.filter((m) => m.name === 'orders')).toHaveLength(1);
    expect(db.sequelize.modelManager.getModel('orders')?.rawAttributes).toHaveProperty('priority');

    await db.close();
  });

  it('preserves view metadata through mergeWithLoadedCollections and instantiates read-only ViewCollection', async () => {
    const db = new Database({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const ds = new MssqlExternalDataSource({ databaseInstance: db });

    const [merged] = ds.mergeWithLoadedCollections(
      [
        {
          name: 'v_sales',
          tableName: 'nb_v_sales',
          view: true,
          viewName: 'nb_v_sales',
          template: 'view',
          writableView: false,
          fields: [{ name: 'id', type: 'integer' }],
        },
      ],
      {
        v_sales: {
          name: 'v_sales',
          title: 'Sales View',
          template: 'general',
          fields: [],
        },
      },
    );

    expect(merged).toMatchObject({
      name: 'v_sales',
      title: 'Sales View',
      view: true,
      viewName: 'nb_v_sales',
      template: 'view',
      writableView: false,
    });

    const collection = ds.collectionManager.defineCollection(merged) as unknown as {
      isView: () => boolean;
      unavailableActions?: () => string[];
      model: { tableName: string };
    };
    expect(collection.isView()).toBe(true);
    expect(collection.model.tableName).toBe('nb_v_sales');
    expect(collection.unavailableActions?.()).toEqual(
      expect.arrayContaining(['create', 'update', 'destroy', 'updateMany', 'destroyMany']),
    );

    await db.close();
  });

  it('closes temporary unloaded sources after getTables/loadTables and failed load without closing reused databases', async () => {
    // 1. Temporary unloaded source closes after introspector.getTables() and close() is idempotent.
    const tempGetTables = new MssqlExternalDataSource({ host: 'localhost', database: 'db' });
    const closeSpy1 = vi.spyOn(tempGetTables.collectionManager.db, 'close').mockResolvedValue(undefined);
    vi.spyOn(tempGetTables.introspector, 'getTableList').mockResolvedValue(['orders']);
    vi.spyOn(tempGetTables.introspector, 'getViewList').mockResolvedValue([]);

    await expect(tempGetTables.introspector.getTables()).resolves.toEqual(['orders']);
    expect(closeSpy1).toHaveBeenCalledTimes(1);
    await tempGetTables.close();
    expect(closeSpy1).toHaveBeenCalledTimes(1);

    // 2. Temporary unloaded source closes after loadTables() even on error.
    const tempLoadTables = new MssqlExternalDataSource({ host: 'localhost', database: 'db' });
    const closeSpy2 = vi.spyOn(tempLoadTables.collectionManager.db, 'close').mockResolvedValue(undefined);
    vi.spyOn(tempLoadTables, 'prepareTables').mockRejectedValue(new Error('introspection failed'));

    await expect(tempLoadTables.loadTables({ action: {} } as never, ['orders'])).rejects.toThrow(
      'introspection failed',
    );
    expect(closeSpy2).toHaveBeenCalledTimes(1);

    // 3. Fresh source closes on failed load().
    const failedFresh = new MssqlExternalDataSource({ host: 'localhost', database: 'db' });
    const closeSpy3 = vi.spyOn(failedFresh.collectionManager.db, 'close').mockResolvedValue(undefined);
    vi.spyOn(failedFresh.collectionManager.db.sequelize, 'authenticate').mockRejectedValue(new Error('auth failed'));

    await expect(failedFresh.load()).rejects.toThrow('auth failed');
    expect(closeSpy3).toHaveBeenCalledTimes(1);

    // 4. Reused database source does NOT close the shared db on failed load().
    const sharedDb = new Database({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const sharedCloseSpy = vi.spyOn(sharedDb, 'close');
    const failedReused = new MssqlExternalDataSource({ databaseInstance: sharedDb });
    vi.spyOn(sharedDb.sequelize, 'authenticate').mockRejectedValue(new Error('transient refresh failure'));

    await expect(failedReused.load()).rejects.toThrow('transient refresh failure');
    expect(sharedCloseSpy).not.toHaveBeenCalled();

    await sharedDb.close();
  });
});
