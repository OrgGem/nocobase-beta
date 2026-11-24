// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from 'events';
import { Database, HasManyRepository, BelongsToManyRepository, BelongsToRepository } from '@nocobase/database';
import { Op } from 'sequelize';
import { describe, expect, it, vi } from 'vitest';
import { formatDatabaseOptions } from '../data-source/MssqlExternalDataSource';
import { MssqlRepository } from '../data-source/MssqlRepository';
import {
  createReadOnlyViewMiddleware,
  installMssqlReadOnlyViewGuard,
  MssqlReadOnlyViewError,
} from '../data-source/mssql-read-only-view';
import { MssqlDialect } from '../dialects/mssql-dialect';
import { createMssqlOperators } from '../operators/mssql-operators';

Database.registerDialect(MssqlDialect);

function createRepoHarness(
  options: {
    fastCount?: boolean;
    deferredJoinThreshold?: number;
    schema?: string;
    isView?: boolean;
    primaryKeyAttributes?: string[];
    rawAttributes?: Record<string, { field?: string; type?: { key?: string } }>;
    isAnsiStringColumn?: (tableName: string, columnName: string) => boolean;
    findAllImpl?: (opts: Record<string, unknown>) => Promise<unknown[]>;
    queryImpl?: (sql: string, opts: Record<string, unknown>) => Promise<unknown[]>;
  } = {},
) {
  const findAll = vi.fn(options.findAllImpl ?? (async () => []));
  const modelCount = vi.fn(async () => 42);
  const query = vi.fn(options.queryImpl ?? (async () => [{ estimate: 123456 }]));
  const emitAsync = vi.fn(async () => undefined);

  const model = {
    tableName: 'Orders',
    options: { schema: options.schema ?? 'sales' },
    primaryKeyAttributes: options.primaryKeyAttributes ?? ['id'],
    primaryKeyAttribute: (options.primaryKeyAttributes ?? ['id'])[0],
    rawAttributes: options.rawAttributes ?? {
      id: { field: 'id', type: { key: 'INTEGER' } },
      title: { field: 'title', type: { key: 'STRING' } },
    },
    associations: {},
    findAll,
    count: modelCount,
  };

  const database = {
    options: {
      schema: options.schema ?? 'sales',
      mssqlRuntimeOptions: {
        fastCount: options.fastCount,
        deferredJoinThreshold: options.deferredJoinThreshold,
        isAnsiStringColumn: options.isAnsiStringColumn,
      },
    },
    sequelize: { query, getDialect: () => 'mssql' },
    logger: { warn: vi.fn(), debug: vi.fn() },
    emitAsync,
  };

  const collection = {
    name: 'orders',
    model,
    db: database,
    context: { database },
    filterTargetKey: 'id',
    tableName: () => 'Orders',
    isView: () => Boolean(options.isView),
    isSql: () => false,
    isParent: () => false,
    isMultiFilterTargetKey: () => false,
  };

  const repo = new MssqlRepository(collection as never);
  vi.spyOn(repo, 'buildQueryOptions').mockImplementation((opts: Record<string, unknown>) => ({
    where: opts.where ?? {},
    attributes: opts.attributes ?? { include: [], exclude: [] },
    limit: opts.limit,
    offset: opts.offset,
    order: opts.order,
    include: opts.include,
    having: opts.having,
  }));

  return { repo, findAll, modelCount, query, emitAsync };
}

describe('MssqlRepository performance optimizations', () => {
  describe('Deferred Join for deep OFFSET pagination', () => {
    it('fetches PKs first and hydrates full rows in original order when offset >= threshold', async () => {
      const hydrated = [
        { get: (k: string) => (k === 'id' ? 30 : 'thirty') },
        { get: (k: string) => (k === 'id' ? 10 : 'ten') },
        { get: (k: string) => (k === 'id' ? 20 : 'twenty') },
      ];
      let call = 0;
      const { repo, findAll, emitAsync } = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async () => {
          call++;
          return call === 1 ? [{ id: 10 }, { id: 20 }, { id: 30 }] : hydrated;
        },
      });

      const rows = await repo.find({ offset: 500, limit: 3 });

      expect(findAll).toHaveBeenCalledTimes(2);
      expect(findAll.mock.calls[0][0]).toMatchObject({ attributes: ['id'], raw: true, offset: 500, limit: 3 });
      expect(findAll.mock.calls[1][0]).toMatchObject({
        where: { id: { [Op.in]: [10, 20, 30] } },
      });
      expect(rows.map((r) => r.get('id'))).toEqual([10, 20, 30]);
      expect(emitAsync).toHaveBeenCalledWith('afterRepositoryFind', expect.objectContaining({ data: rows }));
    });

    it('returns empty immediately without issuing query 2 when query 1 returns no PKs', async () => {
      const { repo, findAll } = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async () => [],
      });

      const rows = await repo.find({ offset: 1000, limit: 20 });

      expect(rows).toEqual([]);
      expect(findAll).toHaveBeenCalledTimes(1);
    });

    it('bypasses Deferred Join for shallow offsets below threshold', async () => {
      const { repo, findAll } = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async () => [{ id: 1 }],
      });

      await repo.find({ offset: 20, limit: 20 });

      expect(findAll).toHaveBeenCalledTimes(1);
      expect(findAll.mock.calls[0][0].raw).not.toBe(true);
    });

    it('bypasses Deferred Join when distinct is true, limit > 1000, or order uses a computed alias', async () => {
      const { repo, findAll } = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async () => [{ id: 1 }],
      });

      await repo.find({ offset: 500, limit: 20, distinct: true } as never);
      await repo.find({ offset: 500, limit: 5000 });
      await repo.find({ offset: 500, limit: 20, order: [['computedRank', 'DESC']] } as never);

      expect(findAll).toHaveBeenCalledTimes(3);
      for (const call of findAll.mock.calls) {
        expect(call[0].raw).not.toBe(true);
      }
    });

    it('temporarily selects PK and strips it afterwards when attributes omit the primary key', async () => {
      const makeRow = (id: number, title: string) => {
        const dataValues: Record<string, unknown> = { id, title };
        const _previousDataValues: Record<string, unknown> = { id, title };
        return {
          dataValues,
          _previousDataValues,
          getDataValue: (k: string) => dataValues[k],
          get: (k: string) => dataValues[k],
        };
      };
      let call = 0;
      const { repo, findAll } = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async () => {
          call++;
          return call === 1 ? [{ id: 20 }, { id: 10 }] : [makeRow(10, 'ten'), makeRow(20, 'twenty')];
        },
      });

      const rows = await repo.find({ offset: 500, limit: 2, attributes: ['title'] } as never);

      expect(findAll).toHaveBeenCalledTimes(2);
      expect(findAll.mock.calls[1][0].attributes).toEqual(['title', 'id']);
      expect(rows.map((r) => r.get('title'))).toEqual(['twenty', 'ten']);
      // Stripped PK must not leak into returned row dataValues.
      expect(rows.map((r) => r.get('id'))).toEqual([undefined, undefined]);
    });

    it('matches hydrated rows via getDataValue() even when get() transforms the PK value', async () => {
      let call = 0;
      const { repo } = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async () => {
          call++;
          return call === 1
            ? [{ id: '100' }, { id: '200' }]
            : [
                { getDataValue: (k: string) => (k === 'id' ? 200 : 'two'), get: () => 'FORMATTED-200' },
                { getDataValue: (k: string) => (k === 'id' ? 100 : 'one'), get: () => 'FORMATTED-100' },
              ];
        },
      });

      const rows = await repo.find({ offset: 500, limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => (r as unknown as { getDataValue: (k: string) => unknown }).getDataValue('title'))).toEqual(
        ['one', 'two'],
      );
    });

    it('bypasses Deferred Join for unsafe PK types (e.g. DATE), views, or HAVING clauses', async () => {
      const dateHarness = createRepoHarness({
        deferredJoinThreshold: 200,
        rawAttributes: {
          id: { field: 'id', type: { key: 'DATE' } },
          title: { field: 'title', type: { key: 'STRING' } },
        },
        findAllImpl: async () => [{ id: new Date('2026-01-01') }],
      });
      await dateHarness.repo.find({ offset: 500, limit: 10 });
      expect(dateHarness.findAll).toHaveBeenCalledTimes(1);
      expect(dateHarness.findAll.mock.calls[0][0].raw).not.toBe(true);

      const viewHarness = createRepoHarness({
        deferredJoinThreshold: 200,
        isView: true,
        findAllImpl: async () => [{ id: 1 }],
      });
      await viewHarness.repo.find({ offset: 500, limit: 10 });
      expect(viewHarness.findAll).toHaveBeenCalledTimes(1);
      expect(viewHarness.findAll.mock.calls[0][0].raw).not.toBe(true);

      const havingHarness = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async () => [{ id: 1 }],
      });
      await havingHarness.repo.find({ offset: 500, limit: 10, having: 'COUNT(*) > 1' } as never);
      expect(havingHarness.findAll).toHaveBeenCalledTimes(1);
      expect(havingHarness.findAll.mock.calls[0][0].raw).not.toBe(true);
    });

    it('falls back to super.find() when query 1 returns duplicate PK values instead of collapsing rows', async () => {
      let call = 0;
      const { repo, findAll } = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async (opts) => {
          call++;
          if (call === 1 && opts.raw) {
            return [{ id: 1 }, { id: 1 }];
          }
          return [
            { get: (k: string) => (k === 'id' ? 1 : 'row-a') },
            { get: (k: string) => (k === 'id' ? 1 : 'row-b') },
          ];
        },
      });

      const rows = await repo.find({ offset: 500, limit: 2 });
      expect(findAll).toHaveBeenCalledTimes(2);
      // 2nd call must be full super.find (not hydration Op.in), preserving both distinct rows.
      expect(findAll.mock.calls[1][0].where).not.toHaveProperty('id');
      expect(rows.map((r) => r.get('title'))).toEqual(['row-a', 'row-b']);
    });

    it('uses ANSI string literals in query 2 Op.in for ASCII VARCHAR primary keys', async () => {
      let call = 0;
      const { repo, findAll } = createRepoHarness({
        deferredJoinThreshold: 200,
        rawAttributes: {
          code: { field: 'OrderCode', type: { key: 'STRING' } },
          title: { field: 'title', type: { key: 'STRING' } },
        },
        primaryKeyAttributes: ['code'],
        isAnsiStringColumn: (table, col) => table === 'Orders' && col === 'OrderCode',
        findAllImpl: async () => {
          call++;
          return call === 1
            ? [{ code: 'ORD-1' }, { code: 'ORD-2' }]
            : [
                { getDataValue: (k: string) => (k === 'code' ? 'ORD-2' : 'two') },
                { getDataValue: (k: string) => (k === 'code' ? 'ORD-1' : 'one') },
              ];
        },
      });

      const rows = await repo.find({ offset: 500, limit: 2 });
      expect(rows).toHaveLength(2);
      const secondWhere = findAll.mock.calls[1][0].where as { code: { [Op.in]: Array<{ val?: string }> } };
      expect(secondWhere.code[Op.in].map((v) => v.val)).toEqual(["'ORD-1'", "'ORD-2'"]);
    });

    it('preserves original WHERE filters in query 2 so rows modified out of the filter between queries are not returned', async () => {
      let call = 0;
      const { repo, findAll } = createRepoHarness({
        deferredJoinThreshold: 200,
        findAllImpl: async () => {
          call++;
          return call === 1
            ? [{ id: 10 }, { id: 20 }]
            : // DB returns only id:20 in query 2 because id:10 changed status out of the filter.
              [{ get: (k: string) => (k === 'id' ? 20 : 'still-open') }];
        },
      });

      const originalWhere = { status: 'open' };
      const rows = await repo.find({ offset: 500, limit: 2, where: originalWhere });

      expect(findAll).toHaveBeenCalledTimes(2);
      expect(findAll.mock.calls[1][0].where).toEqual({
        [Op.and]: [originalWhere, { id: { [Op.in]: [10, 20] } }],
      });
      expect(rows.map((r) => r.get('id'))).toEqual([20]);
    });
  });

  describe('Schema-qualified getEstimatedRowCount & fastCount', () => {
    it('queries sys.partitions with bracket-quoted schema and table name', async () => {
      const { repo, query } = createRepoHarness({ schema: 'sales' });

      const estimate = await repo.getEstimatedRowCount();

      expect(estimate).toBe(123456);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('sys.partitions'),
        expect.objectContaining({ replacements: ['[sales].[Orders]'] }),
      );
    });

    it('returns 0 for views without querying sys.partitions', async () => {
      const { repo, query } = createRepoHarness({ isView: true });

      expect(await repo.getEstimatedRowCount()).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it('uses fastCount for unfiltered count() when enabled, and exact COUNT(*) when filtered', async () => {
      const { repo, query, modelCount } = createRepoHarness({ fastCount: true });

      expect(await repo.count()).toBe(123456);
      expect(query).toHaveBeenCalledTimes(1);
      expect(modelCount).not.toHaveBeenCalled();

      // Filtered count must still run exact COUNT(*)
      vi.spyOn(repo as unknown as { parseFilter: () => Record<string, unknown> }, 'parseFilter').mockReturnValue({
        where: { status: 'open' },
      });
      expect(await repo.count({ filter: { status: 'open' } })).toBe(42);
      expect(modelCount).toHaveBeenCalledTimes(1);
    });
  });

  describe('PK-less paginated queries and composite/PK-less destroy FTS safety', () => {
    it('adds ORDER BY (SELECT NULL) on paginated find() for PK-less MSSQL models instead of crashing in Sequelize', async () => {
      const db = new Database({ dialect: 'mssql', logging: false });
      db.registerRepositories({ 'mssql-repo': MssqlRepository });
      const capturedSql: string[] = [];
      (db.sequelize as unknown as { query: (sql: unknown) => Promise<unknown[]> }).query = async (sql) => {
        capturedSql.push(typeof sql === 'string' ? sql : String((sql as { query?: string })?.query ?? sql));
        return [];
      };

      const collection = db.collection({
        name: 'v_summary',
        tableName: 'v_summary',
        autoGenId: false,
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'code', type: 'string' },
          { name: 'title', type: 'string' },
        ],
      });

      expect(collection.model.primaryKeyField).toBeNull();
      expect(collection.model.primaryKeyAttributes).toEqual([]);

      await collection.repository.find({ limit: 21, offset: 0 });
      expect(capturedSql[0]).toContain('ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 21 ROWS ONLY');

      // Explicit sort must still take precedence over the fallback ORDER BY.
      await collection.repository.find({ limit: 20, offset: 0, sort: ['title'] });
      expect(capturedSql[1]).toContain('ORDER BY [v_summary].[title] ASC OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY');
      expect(capturedSql[1]).not.toContain('(SELECT NULL)');

      await db.close();
    });

    it('uses consistent LIKE substring semantics on FTS-indexed columns across find() and destroy()', async () => {
      const runtimeOpts: { ftsSuspendCount?: number } = {};
      const db = new Database({
        dialect: 'mssql',
        schema: 'sales',
        logging: false,
        mssqlRuntimeOptions: runtimeOpts,
      } as ConstructorParameters<typeof Database>[0]);
      db.registerRepositories({ 'mssql-repo': MssqlRepository });
      db.registerOperators(
        createMssqlOperators(
          { hasFTSIndex: (table, col) => table === 'nb_Orders' && col === 'OrderTitle' },
          () => 'auto',
          () => Boolean(runtimeOpts.ftsSuspendCount && runtimeOpts.ftsSuspendCount > 0),
        ),
      );

      const capturedSql: string[] = [];
      (db.sequelize as unknown as { query: (sql: unknown) => Promise<unknown[]> }).query = async (sql) => {
        capturedSql.push(typeof sql === 'string' ? sql : String((sql as { query?: string })?.query ?? sql));
        return [];
      };

      const collection = db.collection({
        name: 'orders',
        tableName: 'nb_Orders',
        schema: 'sales',
        autoGenId: false,
        timestamps: false,
        repository: 'mssql-repo',
        fields: [{ name: 'title', type: 'string', field: 'OrderTitle' }],
      });

      await collection.repository.find({ filter: { title: { $includes: 'bar' } } });
      expect(capturedSql[0]).toContain(`[orders].[OrderTitle] LIKE N'%bar%'`);
      expect(capturedSql[0]).not.toContain('CONTAINS');

      await collection.repository.destroy({
        filter: { title: { $includes: 'bar' } },
        transaction: { afterCommit: () => undefined } as never,
      });
      const deleteSql = capturedSql.find((sql) => sql.startsWith('DELETE FROM'));
      expect(deleteSql).toBeDefined();
      expect(deleteSql).toContain(`[OrderTitle] LIKE N'%bar%'`);
      expect(deleteSql).not.toContain('CONTAINS');
      expect(deleteSql).not.toContain('[orders].');

      await db.close();
    });
  });

  describe('read-only view enforcement (writableView)', () => {
    it('blocks direct repository write operations on read-only views (writableView !== true)', async () => {
      const db = new Database({ dialect: 'sqlite', storage: ':memory:', logging: false });
      db.registerRepositories({ 'mssql-repo': MssqlRepository });
      installMssqlReadOnlyViewGuard(db);

      const viewCollection = db.collection({
        name: 'v_orders',
        tableName: 'v_orders',
        view: true,
        writableView: false,
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'title', type: 'string' },
        ],
      });
      await db.sync();

      const repo = viewCollection.repository as MssqlRepository;
      await expect(repo.create({ values: { title: 'blocked' } })).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(repo.createMany({ records: [{ title: 'blocked' }] })).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(repo.update({ filter: { id: 1 }, values: { title: 'updated' } })).rejects.toThrow(
        MssqlReadOnlyViewError,
      );
      await expect(repo.updateMany({ filter: {}, values: { title: 'updated' } })).rejects.toThrow(
        MssqlReadOnlyViewError,
      );
      await expect(repo.firstOrCreate({ filterKeys: ['id'], values: { id: 1, title: 'x' } })).rejects.toThrow(
        MssqlReadOnlyViewError,
      );
      await expect(repo.updateOrCreate({ filterKeys: ['id'], values: { id: 1, title: 'x' } })).rejects.toThrow(
        MssqlReadOnlyViewError,
      );
      await expect(repo.destroy({ filter: { id: 1 } })).rejects.toThrow(MssqlReadOnlyViewError);

      await db.close();
    });

    it('blocks relation writes targeting read-only views while allowing writableParent.belongsTo(readOnlyView).set/remove and writableView: true', async () => {
      const db = new Database({ dialect: 'sqlite', storage: ':memory:', logging: false });
      db.registerRepositories({ 'mssql-repo': MssqlRepository });
      installMssqlReadOnlyViewGuard(db);

      // Underlying physical tables allow writes in SQLite so only the view guard can reject them.
      await db.sequelize.query('CREATE TABLE v_customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);');
      await db.sequelize.query(
        'CREATE TABLE v_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, orderId INTEGER);',
      );
      await db.sequelize.query(
        'CREATE TABLE v_writable_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, orderId INTEGER);',
      );
      await db.sequelize.query('CREATE TABLE v_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);');
      await db.sequelize.query(
        'CREATE TABLE v_order_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER, tagId INTEGER);',
      );
      await db.sequelize.query('INSERT INTO v_customers (id, name) VALUES (1, "Alice"), (2, "Bob");');
      await db.sequelize.query(
        'INSERT INTO v_items (id, title, orderId) VALUES (10, "RO Item", 1), (11, "RO Unlinked", NULL);',
      );
      await db.sequelize.query('INSERT INTO v_tags (id, label) VALUES (100, "VIP");');

      db.collection({
        name: 'v_customers',
        tableName: 'v_customers',
        view: true,
        writableView: false,
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'name', type: 'string' },
        ],
      });

      db.collection({
        name: 'v_items',
        tableName: 'v_items',
        view: true,
        writableView: false,
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'title', type: 'string' },
          { name: 'orderId', type: 'integer' },
        ],
      });

      const writableItems = db.collection({
        name: 'v_writable_items',
        tableName: 'v_writable_items',
        view: true,
        writableView: true,
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'title', type: 'string' },
          { name: 'orderId', type: 'integer' },
        ],
      });

      db.collection({
        name: 'v_tags',
        tableName: 'v_tags',
        view: true,
        writableView: false,
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'label', type: 'string' },
        ],
      });

      db.collection({
        name: 'v_order_tags',
        tableName: 'v_order_tags',
        view: true,
        writableView: false,
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'orderId', type: 'integer' },
          { name: 'tagId', type: 'integer' },
        ],
      });

      const orders = db.collection({
        name: 'orders',
        tableName: 'orders',
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true, autoIncrement: true },
          { name: 'customerId', type: 'integer' },
          { name: 'customer', type: 'belongsTo', target: 'v_customers', foreignKey: 'customerId' },
          { name: 'items', type: 'hasMany', target: 'v_items', foreignKey: 'orderId' },
          { name: 'writableItems', type: 'hasMany', target: 'v_writable_items', foreignKey: 'orderId' },
          {
            name: 'tags',
            type: 'belongsToMany',
            target: 'v_tags',
            through: 'v_order_tags',
            foreignKey: 'orderId',
            otherKey: 'tagId',
          },
        ],
      });
      await orders.sync();

      const ordersRepo = orders.repository as MssqlRepository;
      await ordersRepo.create({ values: { id: 1, customerId: 1 } });

      // hasMany -> read-only view rejects create/update/destroy/add/set/remove and nested create.
      const itemsRelRepo = db.getRepository<HasManyRepository>('orders.items', 1);
      await expect(itemsRelRepo.create({ values: { title: 'new' } })).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(itemsRelRepo.update({ filter: { id: 10 }, values: { title: 'edited' } })).rejects.toThrow(
        MssqlReadOnlyViewError,
      );
      await expect(itemsRelRepo.destroy({ filter: { id: 10 } })).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(itemsRelRepo.add(11)).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(itemsRelRepo.set([11])).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(itemsRelRepo.remove(10)).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(
        ordersRepo.create({ values: { id: 2, customerId: 1, items: [{ title: 'nested' }] } }),
      ).rejects.toThrow(MssqlReadOnlyViewError);
      // Verify read-only view table contents remained untouched.
      const roItemsAfter = await db.getCollection('v_items').repository.find({ sort: ['id'], raw: true });
      expect(roItemsAfter).toEqual([
        { id: 10, title: 'RO Item', orderId: 1 },
        { id: 11, title: 'RO Unlinked', orderId: null },
      ]);

      // belongsToMany with read-only through view / target view rejects add/set/remove/create/destroy.
      const tagsRelRepo = db.getRepository<BelongsToManyRepository>('orders.tags', 1);
      await expect(tagsRelRepo.add(100)).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(tagsRelRepo.set([100])).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(tagsRelRepo.remove(100)).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(tagsRelRepo.create({ values: { label: 'new tag' } })).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(tagsRelRepo.destroy({ filter: { id: 100 } })).rejects.toThrow(MssqlReadOnlyViewError);

      // belongsTo -> read-only view rejects updating/destroying the target view row,
      // while linking/unlinking via orders.customerId succeeds on the writable parent table.
      const customerRelRepo = db.getRepository<BelongsToRepository>('orders.customer', 1);
      await expect(customerRelRepo.update({ values: { name: 'Mutated' } })).rejects.toThrow(MssqlReadOnlyViewError);
      await expect(customerRelRepo.destroy()).rejects.toThrow(MssqlReadOnlyViewError);
      await customerRelRepo.set(2);
      const linked = await ordersRepo.findOne({ filterByTk: 1 });
      expect(linked?.get('customerId')).toBe(2);
      await customerRelRepo.remove();
      const unlinked = await ordersRepo.findOne({ filterByTk: 1 });
      expect(unlinked?.get('customerId')).toBeNull();

      // View explicitly configured with writableView: true allows direct and relation writes.
      const writableRepo = writableItems.repository as MssqlRepository;
      await writableRepo.create({ values: { id: 50, title: 'writable direct', orderId: 1 } });
      await writableRepo.update({ filterByTk: 50, values: { title: 'writable updated' } });
      const writableRelRepo = db.getRepository<HasManyRepository>('orders.writableItems', 1);
      await writableRelRepo.create({ values: { id: 51, title: 'writable via relation' } });
      const foundWritable = await writableRepo.find({ sort: ['id'] });
      expect(foundWritable.map((r) => r.get('title'))).toEqual(['writable updated', 'writable via relation']);
      await writableRepo.destroy({ filterByTk: 50 });

      await db.close();
    });

    it('rejects read-only view actions with 403 in middleware and permits writableView: true and parent belongsTo links', async () => {
      const db = new Database({ dialect: 'sqlite', storage: ':memory:', logging: false });
      db.collection({
        name: 'v_items',
        view: true,
        writableView: false,
        fields: [{ name: 'id', type: 'integer', primaryKey: true }],
      });
      db.collection({
        name: 'v_writable_items',
        view: true,
        writableView: true,
        fields: [{ name: 'id', type: 'integer', primaryKey: true }],
      });
      db.collection({
        name: 'v_order_tags',
        view: true,
        writableView: false,
        fields: [
          { name: 'orderId', type: 'integer' },
          { name: 'tagId', type: 'integer' },
        ],
      });
      db.collection({
        name: 'v_orders',
        view: true,
        writableView: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'customerId', type: 'integer' },
          { name: 'customer', type: 'belongsTo', target: 'customers', foreignKey: 'customerId' },
        ],
      });
      db.collection({
        name: 'customers',
        fields: [{ name: 'id', type: 'integer', primaryKey: true }],
      });
      db.collection({
        name: 'orders',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'customerId', type: 'integer' },
          { name: 'customer', type: 'belongsTo', target: 'v_items', foreignKey: 'customerId' },
          { name: 'items', type: 'hasMany', target: 'v_items', foreignKey: 'orderId' },
          {
            name: 'tags',
            type: 'belongsToMany',
            target: 'customers',
            through: 'v_order_tags',
            foreignKey: 'orderId',
            otherKey: 'tagId',
          },
        ],
      });

      const middleware = createReadOnlyViewMiddleware(() => db);
      const invoke = async (resourceName: string, actionName: string, nextImpl = async () => undefined) => {
        const thrown: Array<{ status: number; message: string }> = [];
        const ctx = {
          action: { resourceName, actionName },
          throw(status: number, message: string) {
            thrown.push({ status, message });
            const err = new Error(message) as Error & { status: number };
            err.status = status;
            throw err;
          },
        };
        await expect(middleware(ctx as never, nextImpl)).rejects.toThrow('This collection is read-only');
        expect(thrown[0]).toEqual({ status: 403, message: 'This collection is read-only' });
      };

      await invoke('v_items', 'create');
      await invoke('orders.items', 'create');
      await invoke('orders.tags', 'add');
      await invoke('v_orders.customer', 'set');
      await invoke('v_orders.customer', 'create');

      // Maps lower-layer MssqlReadOnlyViewError to HTTP 403 even if triggered inside next().
      await invoke('customers', 'create', async () => {
        throw new MssqlReadOnlyViewError();
      });

      // Allows writable parent linking existing belongsTo view row and writableView: true actions.
      const nextSpy = vi.fn(async () => undefined);
      await middleware(
        {
          action: { resourceName: 'orders.customer', actionName: 'set' },
          throw: vi.fn(),
        } as never,
        nextSpy,
      );
      await middleware(
        {
          action: { resourceName: 'v_writable_items', actionName: 'create' },
          throw: vi.fn(),
        } as never,
        nextSpy,
      );
      expect(nextSpy).toHaveBeenCalledTimes(2);

      await db.close();
    });
  });

  describe('single-query streaming for collections without unique keys', () => {
    const createMockStreamHarness = (allRows: Array<{ ItemCode: string; ItemTitle: string }>) => {
      const db = new Database({
        ...formatDatabaseOptions({
          host: 'localhost',
          database: 'sales',
          username: 'sa',
          password: 'secret',
        }),
        logging: false,
      });
      db.registerRepositories({ 'mssql-repo': MssqlRepository });

      const collection = db.collection({
        name: 'audit_items',
        tableName: 'AuditItems',
        schema: 'dbo',
        timestamps: false,
        autoGenId: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'code', field: 'ItemCode', type: 'string' },
          { name: 'title', field: 'ItemTitle', type: 'string' },
        ],
      });
      // Simulate external unique-less table/view with zero primaryKeyAttributes
      collection.model.removeAttribute('id');

      // Spy on Sequelize.prototype.query (not an own property on db.sequelize) so metadata probe returns
      // empty unique indexes while table queries are forced through the tedious Request streaming path.
      const protoQuerySpy = vi
        .spyOn(Object.getPrototypeOf(db.sequelize), 'query')
        .mockImplementation(async (sql: unknown) => {
          if (typeof sql === 'string' && sql.includes('sys.indexes')) {
            return [[]];
          }
          throw new Error(`Unexpected fallback sequelize.query during single-query stream: ${String(sql)}`);
        });

      const executedSql: string[] = [];
      const lifecycleEvents: string[] = [];
      let releasedCount = 0;
      let inFlightCompleted = false;

      class MockTediousRequest {
        sql: string;
        private completeCb: (err?: Error | null, rowCount?: number) => void;
        private rowListeners: Array<(columns: unknown) => void> = [];
        private cursor = 0;
        private paused = false;
        private cancelled = false;
        private finished = false;
        private pumping = false;

        constructor(sql: string, callback: (err?: Error | null, rowCount?: number) => void) {
          this.sql = sql;
          this.completeCb = callback;
        }

        on(event: 'row', listener: (columns: unknown) => void) {
          if (event === 'row') {
            this.rowListeners.push(listener);
          }
          return this;
        }

        pause() {
          this.paused = true;
          lifecycleEvents.push(`pause@${this.cursor}`);
        }

        resume() {
          if (!this.paused || this.finished) {
            return;
          }
          this.paused = false;
          lifecycleEvents.push(`resume@${this.cursor}`);
          queueMicrotask(() => this.pump());
        }

        cancel() {
          if (this.finished) {
            return;
          }
          this.cancelled = true;
          lifecycleEvents.push(`cancel@${this.cursor}`);
          this.paused = false;
          queueMicrotask(() => this.finish());
        }

        start() {
          queueMicrotask(() => this.pump());
        }

        private finish() {
          if (this.finished) {
            return;
          }
          this.finished = true;
          inFlightCompleted = true;
          this.completeCb(null, this.cursor);
        }

        private pump() {
          if (this.pumping || this.finished) {
            return;
          }
          this.pumping = true;
          try {
            while (!this.paused && !this.cancelled && !this.finished && this.cursor < allRows.length) {
              const row = allRows[this.cursor];
              this.cursor += 1;
              const columns = [
                { value: row.ItemCode, metadata: { colName: 'code', type: { id: 0xe7 } } },
                { value: row.ItemTitle, metadata: { colName: 'title', type: { id: 0xe7 } } },
              ];
              for (const listener of this.rowListeners) {
                listener(columns);
              }
            }
            if (!this.paused && !this.finished && (this.cancelled || this.cursor >= allRows.length)) {
              this.finish();
            }
          } finally {
            this.pumping = false;
          }
        }
      }

      const mockConnection = {
        lib: { Request: MockTediousRequest },
        execSql: (request: MockTediousRequest) => {
          inFlightCompleted = false;
          executedSql.push(request.sql);
          request.start();
        },
      };

      const connMgr = db.sequelize.connectionManager as unknown as {
        getConnection: (opts: { type?: string }) => Promise<unknown>;
        releaseConnection: (conn: unknown) => Promise<void>;
      };
      const getConnSpy = vi.spyOn(connMgr, 'getConnection').mockResolvedValue(mockConnection);
      const releaseConnSpy = vi.spyOn(connMgr, 'releaseConnection').mockImplementation(async () => {
        expect(inFlightCompleted).toBe(true);
        releasedCount += 1;
      });

      const close = async () => {
        protoQuerySpy.mockRestore();
        getConnSpy.mockRestore();
        releaseConnSpy.mockRestore();
        await db.close();
      };

      return {
        repo: collection.repository as MssqlRepository,
        executedSql,
        lifecycleEvents,
        close,
        getReleasedCount: () => releasedCount,
      };
    };

    it('streams unbounded chunkWithCursor() in a single SELECT with pause/resume backpressure and zero OFFSET drift', async () => {
      const sampleRows = [
        { ItemCode: 'A', ItemTitle: 'first' },
        { ItemCode: 'A', ItemTitle: 'second' },
        { ItemCode: 'A', ItemTitle: 'third' },
        { ItemCode: 'B', ItemTitle: 'fourth' },
        { ItemCode: 'B', ItemTitle: 'fifth' },
      ];
      const { repo, executedSql, lifecycleEvents, close, getReleasedCount } = createMockStreamHarness(sampleRows);

      const batches: Array<Array<{ code: string; title: string }>> = [];
      try {
        await repo.chunkWithCursor({
          chunkSize: 2,
          callback: async (rows) => {
            await Promise.resolve();
            batches.push(rows.map((r) => ({ code: String(r.get('code')), title: String(r.get('title')) })));
          },
        });
      } finally {
        await close();
      }

      expect(executedSql).toHaveLength(1);
      expect(executedSql[0]).toMatch(/\[ItemCode\] AS \[code\]/);
      expect(executedSql[0]).toMatch(/\[ItemTitle\] AS \[title\]/);
      expect(executedSql[0]).not.toMatch(/OFFSET/i);
      expect(executedSql[0]).not.toMatch(/ORDER BY\s*\(SELECT NULL\)/i);
      expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
      expect(batches.flat()).toEqual([
        { code: 'A', title: 'first' },
        { code: 'A', title: 'second' },
        { code: 'A', title: 'third' },
        { code: 'B', title: 'fourth' },
        { code: 'B', title: 'fifth' },
      ]);
      expect(lifecycleEvents).toEqual(['pause@2', 'resume@2', 'pause@4', 'resume@4']);
      expect(getReleasedCount()).toBe(1);
    });

    it('streams repo.chunk() with overall limit in a single SELECT, handles tail batch < chunkSize, and cancels before releasing', async () => {
      const sampleRows = [
        { ItemCode: 'A', ItemTitle: 'first' },
        { ItemCode: 'A', ItemTitle: 'second' },
        { ItemCode: 'A', ItemTitle: 'third' },
        { ItemCode: 'B', ItemTitle: 'fourth' },
        { ItemCode: 'B', ItemTitle: 'fifth' },
      ];
      const { repo, executedSql, lifecycleEvents, close, getReleasedCount } = createMockStreamHarness(sampleRows);

      const batches: Array<Array<{ code: string; title: string }>> = [];
      try {
        await repo.chunk({
          chunkSize: 2,
          limit: 3,
          callback: async (rows) => {
            await Promise.resolve();
            batches.push(rows.map((r) => ({ code: String(r.get('code')), title: String(r.get('title')) })));
          },
        });
      } finally {
        await close();
      }

      expect(executedSql).toHaveLength(1);
      expect(executedSql[0]).toMatch(/OFFSET 0 ROWS FETCH NEXT 3 ROWS ONLY/i);
      expect(executedSql[0]).toMatch(/ORDER BY\s*\(SELECT NULL\)/i);
      expect(batches.map((b) => b.length)).toEqual([2, 1]);
      expect(batches.flat()).toEqual([
        { code: 'A', title: 'first' },
        { code: 'A', title: 'second' },
        { code: 'A', title: 'third' },
      ]);
      expect(lifecycleEvents).toContain('pause@2');
      expect(lifecycleEvents).toContain('resume@2');
      expect(lifecycleEvents).toContain('pause@3');
      expect(lifecycleEvents).toContain('cancel@3');
      expect(getReleasedCount()).toBe(1);
    });

    it('streams unbounded relation export (appends) per chunk without full-table find() buffering', async () => {
      const db = new Database({
        ...formatDatabaseOptions({
          host: 'localhost',
          database: 'sales',
          username: 'sa',
          password: 'secret',
        }),
        logging: false,
      });
      db.registerRepositories({ 'mssql-repo': MssqlRepository });

      const customers = db.collection({
        name: 'customers',
        tableName: 'Customers',
        schema: 'dbo',
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'name', type: 'string' },
        ],
      });
      const auditItems = db.collection({
        name: 'audit_items',
        tableName: 'AuditItems',
        schema: 'dbo',
        timestamps: false,
        autoGenId: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'code', field: 'ItemCode', type: 'string' },
          { name: 'title', field: 'ItemTitle', type: 'string' },
          { name: 'customerId', field: 'CustomerId', type: 'integer' },
          { name: 'customer', type: 'belongsTo', target: 'customers', foreignKey: 'customerId', targetKey: 'id' },
        ],
      });
      auditItems.model.removeAttribute('id');

      const allRows = [
        { ItemCode: 'A', ItemTitle: 'first', CustomerId: 10 },
        { ItemCode: 'A', ItemTitle: 'second', CustomerId: 20 },
        { ItemCode: 'B', ItemTitle: 'third', CustomerId: 30 },
      ];
      const eventOrder: string[] = [];
      const protoQuerySpy = vi
        .spyOn(Object.getPrototypeOf(db.sequelize), 'query')
        .mockImplementation(async (sql: unknown) => {
          if (typeof sql === 'string' && sql.includes('sys.indexes')) {
            return [[]];
          }
          throw new Error(`Unexpected fallback sequelize.query during relation stream: ${String(sql)}`);
        });

      const customerQueries: Array<unknown[]> = [];
      const custSpy = vi.spyOn(customers.model, 'findAll').mockImplementation(async (opts: Record<string, unknown>) => {
        const whereObj = (opts.where || {}) as { id?: number[] };
        const ids = Array.isArray(whereObj.id) ? whereObj.id : [];
        customerQueries.push(ids);
        eventOrder.push(`customers:[${ids.join(',')}]`);
        return ids.map((id) => customers.model.build({ id, name: `Cust-${id}` }, { isNewRecord: false }));
      });

      const repo = auditItems.repository as MssqlRepository;
      const findSpy = vi.spyOn(repo, 'find');

      const executedSql: string[] = [];
      class MockTediousRelationRequest {
        sql: string;
        private completeCb: (err?: Error | null, rowCount?: number) => void;
        private rowListeners: Array<(columns: unknown) => void> = [];
        private cursor = 0;
        private paused = false;
        private finished = false;
        private pumping = false;

        constructor(sql: string, callback: (err?: Error | null, rowCount?: number) => void) {
          this.sql = sql;
          this.completeCb = callback;
        }
        on(event: 'row', listener: (columns: unknown) => void) {
          if (event === 'row') this.rowListeners.push(listener);
          return this;
        }
        pause() {
          this.paused = true;
          eventOrder.push(`pause@${this.cursor}`);
        }
        resume() {
          if (!this.paused || this.finished) return;
          this.paused = false;
          eventOrder.push(`resume@${this.cursor}`);
          queueMicrotask(() => this.pump());
        }
        start() {
          queueMicrotask(() => this.pump());
        }
        private pump() {
          if (this.pumping || this.finished) return;
          this.pumping = true;
          try {
            while (!this.paused && !this.finished && this.cursor < allRows.length) {
              const row = allRows[this.cursor];
              this.cursor += 1;
              const columns = [
                { value: row.ItemCode, metadata: { colName: 'code', type: { id: 0xe7 } } },
                { value: row.ItemTitle, metadata: { colName: 'title', type: { id: 0xe7 } } },
                { value: row.CustomerId, metadata: { colName: 'customerId', type: { id: 0x38 } } },
              ];
              for (const listener of this.rowListeners) listener(columns);
            }
            if (!this.paused && !this.finished && this.cursor >= allRows.length) {
              this.finished = true;
              this.completeCb(null, this.cursor);
            }
          } finally {
            this.pumping = false;
          }
        }
      }

      const connMgr = db.sequelize.connectionManager as unknown as {
        getConnection: (opts: { type?: string }) => Promise<unknown>;
        releaseConnection: (conn: unknown) => Promise<void>;
      };
      const getConnSpy = vi.spyOn(connMgr, 'getConnection').mockResolvedValue({
        lib: { Request: MockTediousRelationRequest },
        execSql: (request: MockTediousRelationRequest) => {
          executedSql.push(request.sql);
          request.start();
        },
      });
      const releaseConnSpy = vi.spyOn(connMgr, 'releaseConnection').mockResolvedValue(undefined);

      const delivered: Array<{ code: string; customerName?: string; leakedFk: boolean }> = [];
      try {
        await repo.chunkWithCursor({
          chunkSize: 2,
          fields: ['code', 'title', 'customer.name'],
          callback: async (rows) => {
            eventOrder.push(`deliver:${rows.length}`);
            for (const r of rows) {
              const cust = r.get('customer') as { get?: (k: string) => unknown } | undefined;
              delivered.push({
                code: String(r.get('code')),
                customerName: cust?.get ? String(cust.get('name')) : undefined,
                leakedFk: 'customerId' in r.dataValues,
              });
            }
          },
        });
      } finally {
        protoQuerySpy.mockRestore();
        custSpy.mockRestore();
        getConnSpy.mockRestore();
        releaseConnSpy.mockRestore();
        await db.close();
      }

      expect(findSpy).not.toHaveBeenCalled();
      expect(executedSql).toHaveLength(1);
      expect(customerQueries).toEqual([[10, 20], [30]]);
      expect(delivered).toEqual([
        { code: 'A', customerName: 'Cust-10', leakedFk: false },
        { code: 'A', customerName: 'Cust-20', leakedFk: false },
        { code: 'B', customerName: 'Cust-30', leakedFk: false },
      ]);
      // Batch 1 must hydrate & deliver while stream is paused at row 2 before resuming row 3.
      expect(eventOrder).toEqual([
        'pause@2',
        'customers:[10,20]',
        'deliver:2',
        'resume@2',
        'customers:[30]',
        'deliver:1',
      ]);
    });

    it('rejects unbounded or oversized fallback when non-streamable options are used on a unique-less collection', async () => {
      const db = new Database({
        ...formatDatabaseOptions({
          host: 'localhost',
          database: 'sales',
          username: 'sa',
          password: 'secret',
        }),
        logging: false,
      });
      db.registerRepositories({ 'mssql-repo': MssqlRepository });

      const auditItems = db.collection({
        name: 'audit_items',
        tableName: 'AuditItems',
        schema: 'dbo',
        timestamps: false,
        autoGenId: false,
        repository: 'mssql-repo',
        fields: [{ name: 'code', field: 'ItemCode', type: 'string' }],
      });
      auditItems.model.removeAttribute('id');

      const protoQuerySpy = vi
        .spyOn(Object.getPrototypeOf(db.sequelize), 'query')
        .mockImplementation(async (sql: unknown) => {
          if (typeof sql === 'string' && sql.includes('sys.indexes')) {
            return [[]];
          }
          return [[]];
        });

      const repo = auditItems.repository as MssqlRepository;
      const findSpy = vi
        .spyOn(repo, 'find')
        .mockResolvedValue([
          auditItems.model.build({ code: 'A' }, { isNewRecord: false }),
          auditItems.model.build({ code: 'B' }, { isNewRecord: false }),
        ]);

      try {
        await expect(
          repo.chunkWithCursor({
            chunkSize: 100,
            distinct: true,
            callback: async () => undefined,
          }),
        ).rejects.toThrow(/Cannot buffer unbounded or large result sets/);
        expect(findSpy).not.toHaveBeenCalled();

        await expect(
          repo.chunkWithCursor({
            chunkSize: 100,
            limit: 50_000,
            distinct: true,
            callback: async () => undefined,
          }),
        ).rejects.toThrow(/Cannot buffer unbounded or large result sets/);
        expect(findSpy).not.toHaveBeenCalled();

        // Small bounded non-streamable queries still work within maxUnkeyedBufferRows.
        const batches: string[][] = [];
        await repo.chunkWithCursor({
          chunkSize: 1,
          limit: 2,
          distinct: true,
          callback: async (rows) => {
            batches.push(rows.map((r) => String(r.get('code'))));
          },
        });
        expect(findSpy).toHaveBeenCalledTimes(1);
        expect(batches).toEqual([['A'], ['B']]);
      } finally {
        protoQuerySpy.mockRestore();
        await db.close();
      }
    });

    it('avoids pool.max = 1 acquire timeouts on relation exports and bounds concurrent dedicated streams', async () => {
      const parentRows = [
        { ItemCode: 'A', ItemTitle: 'first', CustomerId: 10 },
        { ItemCode: 'B', ItemTitle: 'second', CustomerId: 20 },
        { ItemCode: 'C', ItemTitle: 'third', CustomerId: 30 },
      ];
      const customerRows = [
        { id: 10, name: 'Cust-10' },
        { id: 20, name: 'Cust-20' },
        { id: 30, name: 'Cust-30' },
      ];

      let activeConnections = 0;
      let peakConnections = 0;

      class FakeTediousRequest {
        sql: string;
        parameters: Record<string, unknown> = {};
        private callback: (err?: Error | null, rowCount?: number) => void;
        private rowListeners: Array<(columns: unknown) => void> = [];
        private cursor = 0;
        private paused = false;
        private cancelled = false;
        private finished = false;
        private pumping = false;
        private rowsToSend: Array<Array<{ value: unknown; metadata: { colName: string; type: { id: number } } }>> = [];

        constructor(sql: string, callback: (err?: Error | null, rowCount?: number) => void) {
          this.sql = sql;
          this.callback = callback;
        }

        addParameter(key: string, _type: unknown, value: unknown) {
          this.parameters[key] = value;
        }

        on(event: string, listener: (columns: unknown) => void) {
          if (event === 'row') {
            this.rowListeners.push(listener);
          }
          return this;
        }

        pause() {
          this.paused = true;
        }

        resume() {
          if (!this.paused || this.finished) {
            return;
          }
          this.paused = false;
          queueMicrotask(() => this.pump());
        }

        cancel() {
          if (this.finished) {
            return;
          }
          this.cancelled = true;
          this.paused = false;
          queueMicrotask(() => this.finish());
        }

        start() {
          if (this.sql.includes('sys.indexes')) {
            this.rowsToSend = [];
          } else if (this.sql.includes('SERVERPROPERTY')) {
            this.rowsToSend = [[{ value: '15.0.2000', metadata: { colName: '', type: { id: 0xe7 } } }]];
          } else if (this.sql.includes('FROM [dbo].[Customers]')) {
            const whereClause = this.sql.split('ORDER BY')[0] ?? this.sql;
            const matched = customerRows.filter((cust) => new RegExp(`\\b${cust.id}\\b`).test(whereClause));
            this.rowsToSend = matched.map((c) => [
              { value: c.id, metadata: { colName: 'id', type: { id: 0x38 } } },
              { value: c.name, metadata: { colName: 'name', type: { id: 0xe7 } } },
            ]);
          } else if (this.sql.includes('FROM [dbo].[AuditItems]')) {
            this.rowsToSend = parentRows.map((r) => [
              { value: r.ItemCode, metadata: { colName: 'code', type: { id: 0xe7 } } },
              { value: r.ItemTitle, metadata: { colName: 'title', type: { id: 0xe7 } } },
              { value: r.CustomerId, metadata: { colName: 'customerId', type: { id: 0x38 } } },
            ]);
          }
          queueMicrotask(() => this.pump());
        }

        private finish() {
          if (this.finished) {
            return;
          }
          this.finished = true;
          this.callback(null, this.cursor);
        }

        private pump() {
          if (this.pumping || this.finished) {
            return;
          }
          this.pumping = true;
          try {
            while (!this.paused && !this.cancelled && !this.finished && this.cursor < this.rowsToSend.length) {
              const row = this.rowsToSend[this.cursor];
              this.cursor += 1;
              for (const listener of this.rowListeners) {
                listener(row);
              }
            }
            if (!this.paused && !this.finished && (this.cancelled || this.cursor >= this.rowsToSend.length)) {
              this.finish();
            }
          } finally {
            this.pumping = false;
          }
        }
      }

      class FakeTediousConnection extends EventEmitter {
        STATE = { INITIALIZED: 0, LOGGED_IN: 4 };
        state: { name?: string } | number = 0;
        loggedIn = false;
        closed = false;

        connect() {
          activeConnections += 1;
          peakConnections = Math.max(peakConnections, activeConnections);
          queueMicrotask(() => {
            this.loggedIn = true;
            this.state = { name: 'LoggedIn' };
            this.emit('connect');
          });
        }

        execSql(request: FakeTediousRequest) {
          request.start();
        }

        close() {
          if (this.closed) {
            return;
          }
          this.closed = true;
          activeConnections = Math.max(0, activeConnections - 1);
          queueMicrotask(() => {
            this.emit('end');
          });
        }
      }

      const fakeDialectModule = {
        Connection: FakeTediousConnection,
        Request: FakeTediousRequest,
        TYPES: {
          NVarChar: { id: 0xe7 },
          Int: { id: 0x38 },
          BigInt: { id: 0x7f },
          Bit: { id: 0x68 },
          Numeric: { id: 0x6c },
          VarChar: { id: 0xa7 },
          VarBinary: { id: 0xa5 },
        },
        ISOLATION_LEVEL: { READ_UNCOMMITTED: 0x01 },
      };

      const baseOpts = formatDatabaseOptions({
        host: 'localhost',
        database: 'sales',
        username: 'sa',
        password: 'secret',
      });
      delete (baseOpts as { dialectModulePath?: string }).dialectModulePath;
      const db = new Database({
        ...baseOpts,
        dialectModule: fakeDialectModule,
        databaseVersion: '15.0.0',
        pool: { max: 1, min: 0, acquire: 250, evict: 1000, idle: 10_000 },
        mssqlRuntimeOptions: { maxConcurrentStreams: 2 },
        logging: false,
      } as never);
      db.registerRepositories({ 'mssql-repo': MssqlRepository });

      const customers = db.collection({
        name: 'customers',
        tableName: 'Customers',
        schema: 'dbo',
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'name', type: 'string' },
        ],
      });
      const auditItems = db.collection({
        name: 'audit_items',
        tableName: 'AuditItems',
        schema: 'dbo',
        timestamps: false,
        autoGenId: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'code', field: 'ItemCode', type: 'string' },
          { name: 'title', field: 'ItemTitle', type: 'string' },
          { name: 'customerId', field: 'CustomerId', type: 'integer' },
          { name: 'customer', type: 'belongsTo', target: 'customers', foreignKey: 'customerId', targetKey: 'id' },
        ],
      });
      auditItems.model.removeAttribute('id');

      const connMgr = db.sequelize.connectionManager as unknown as {
        _connect: (config: Record<string, unknown>) => Promise<unknown>;
        _disconnect: (conn: unknown) => Promise<void>;
      };
      let activeDedicatedStreams = 0;
      let peakDedicatedStreams = 0;
      const origConnect = connMgr._connect.bind(connMgr);
      const origDisconnect = connMgr._disconnect.bind(connMgr);
      const connectSpy = vi.spyOn(connMgr, '_connect').mockImplementation(async (cfg) => {
        activeDedicatedStreams += 1;
        peakDedicatedStreams = Math.max(peakDedicatedStreams, activeDedicatedStreams);
        return await origConnect(cfg);
      });
      const disconnectSpy = vi.spyOn(connMgr, '_disconnect').mockImplementation(async (conn) => {
        activeDedicatedStreams = Math.max(0, activeDedicatedStreams - 1);
        return await origDisconnect(conn);
      });

      const custSpy = vi.spyOn(customers.model, 'findAll');
      const repo = auditItems.repository as MssqlRepository;

      try {
        const exportResults = await Promise.all(
          Array.from({ length: 4 }, async () => {
            const rowsOut: Array<{ code: string; customerName: string }> = [];
            await repo.chunkWithCursor({
              chunkSize: 2,
              fields: ['code', 'title', 'customer.name'],
              callback: async (rows) => {
                for (const r of rows) {
                  const cust = r.get('customer') as { get: (k: string) => unknown } | undefined;
                  rowsOut.push({
                    code: String(r.get('code')),
                    customerName: String(cust?.get('name')),
                  });
                }
              },
            });
            return rowsOut;
          }),
        );

        const expected = [
          { code: 'A', customerName: 'Cust-10' },
          { code: 'B', customerName: 'Cust-20' },
          { code: 'C', customerName: 'Cust-30' },
        ];
        expect(exportResults).toEqual([expected, expected, expected, expected]);
        expect(custSpy).toHaveBeenCalled();
        // 1 pool connection + up to 2 semaphore-bounded dedicated stream connections = <= 3 total across 4 exports.
        expect(peakDedicatedStreams).toBeLessThanOrEqual(3);
        expect(peakConnections).toBeLessThanOrEqual(3);
        expect(activeConnections).toBeLessThanOrEqual(1);
      } finally {
        await db.close();
        connectSpy.mockRestore();
        disconnectSpy.mockRestore();
        custSpy.mockRestore();
      }
      expect(activeDedicatedStreams).toBe(0);
      expect(activeConnections).toBe(0);
    });

    it('enforces maxUnkeyedBufferRows bound on HasMany and BelongsToMany child queries even at chunkSize = 1', async () => {
      const setupDb = (relationType: 'hasMany' | 'belongsToMany') => {
        const db = new Database({
          ...formatDatabaseOptions({
            host: 'localhost',
            database: 'sales',
            username: 'sa',
            password: 'secret',
          }),
          mssqlRuntimeOptions: { maxUnkeyedBufferRows: 4 },
          logging: false,
        } as never);
        db.registerRepositories({ 'mssql-repo': MssqlRepository });

        const tags = db.collection({
          name: 'tags',
          tableName: 'Tags',
          schema: 'dbo',
          timestamps: false,
          repository: 'mssql-repo',
          fields: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'label', type: 'string' },
          ],
        });
        const orderTags = db.collection({
          name: 'order_tags',
          tableName: 'OrderTags',
          schema: 'dbo',
          timestamps: false,
          autoGenId: false,
          repository: 'mssql-repo',
          fields: [
            { name: 'orderCode', type: 'string' },
            { name: 'tagId', type: 'integer' },
          ],
        });
        orderTags.model.removeAttribute('id');

        const orderItems = db.collection({
          name: 'order_items',
          tableName: 'OrderItems',
          schema: 'dbo',
          timestamps: false,
          repository: 'mssql-repo',
          fields: [
            { name: 'id', type: 'integer', primaryKey: true },
            { name: 'orderCode', type: 'string' },
            { name: 'sku', type: 'string' },
          ],
        });

        const parentFields: Array<Record<string, unknown>> = [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'code', field: 'OrderCode', type: 'string' },
          { name: 'title', field: 'OrderTitle', type: 'string' },
        ];
        if (relationType === 'hasMany') {
          parentFields.push({
            name: 'items',
            type: 'hasMany',
            target: 'order_items',
            sourceKey: 'code',
            foreignKey: 'orderCode',
          });
        } else {
          parentFields.push({
            name: 'tags',
            type: 'belongsToMany',
            target: 'tags',
            through: 'order_tags',
            sourceKey: 'code',
            foreignKey: 'orderCode',
            otherKey: 'tagId',
            targetKey: 'id',
          });
        }
        const orders = db.collection({
          name: 'orders',
          tableName: 'Orders',
          schema: 'dbo',
          timestamps: false,
          autoGenId: false,
          repository: 'mssql-repo',
          fields: parentFields as never,
        });
        orders.model.removeAttribute('id');

        return { db, orders, orderItems, orderTags, tags };
      };

      const attachStreamMock = (db: Database, ordersRows: Array<{ OrderCode: string; OrderTitle: string }>) => {
        const protoQuerySpy = vi
          .spyOn(Object.getPrototypeOf(db.sequelize), 'query')
          .mockImplementation(async (sql: unknown) => {
            if (typeof sql === 'string' && sql.includes('sys.indexes')) {
              return [[]];
            }
            throw new Error(`Unexpected query: ${String(sql)}`);
          });

        let releasedCount = 0;
        let cancelled = false;
        class SingleParentRequest {
          sql: string;
          private cb: (err?: Error | null, rowCount?: number) => void;
          private listeners: Array<(cols: unknown) => void> = [];
          private cursor = 0;
          private paused = false;
          private finished = false;
          constructor(sql: string, cb: (err?: Error | null, rowCount?: number) => void) {
            this.sql = sql;
            this.cb = cb;
          }
          on(event: 'row', listener: (cols: unknown) => void) {
            if (event === 'row') this.listeners.push(listener);
            return this;
          }
          pause() {
            this.paused = true;
          }
          resume() {
            this.paused = false;
            queueMicrotask(() => this.pump());
          }
          cancel() {
            cancelled = true;
            this.paused = false;
            queueMicrotask(() => this.finish());
          }
          start() {
            queueMicrotask(() => this.pump());
          }
          private finish() {
            if (this.finished) return;
            this.finished = true;
            this.cb(null, this.cursor);
          }
          private pump() {
            while (!this.paused && !this.finished && !cancelled && this.cursor < ordersRows.length) {
              const row = ordersRows[this.cursor];
              this.cursor += 1;
              const cols = [
                { value: row.OrderCode, metadata: { colName: 'code', type: { id: 0xe7 } } },
                { value: row.OrderTitle, metadata: { colName: 'title', type: { id: 0xe7 } } },
              ];
              for (const l of this.listeners) l(cols);
            }
            if (!this.paused && !this.finished && (cancelled || this.cursor >= ordersRows.length)) {
              this.finish();
            }
          }
        }

        const connMgr = db.sequelize.connectionManager as unknown as {
          getConnection: (opts: { type?: string }) => Promise<unknown>;
          releaseConnection: (conn: unknown) => Promise<void>;
        };
        const getConnSpy = vi.spyOn(connMgr, 'getConnection').mockResolvedValue({
          lib: { Request: SingleParentRequest },
          execSql: (req: SingleParentRequest) => req.start(),
        });
        const releaseConnSpy = vi.spyOn(connMgr, 'releaseConnection').mockImplementation(async () => {
          releasedCount += 1;
        });

        return {
          getState: () => ({ releasedCount, cancelled }),
          cleanup: async () => {
            protoQuerySpy.mockRestore();
            getConnSpy.mockRestore();
            releaseConnSpy.mockRestore();
            await db.close();
          },
        };
      };

      // 1. HasMany: 1 parent with 20 children under maxUnkeyedBufferRows=4 must query with limit=5 and fail fast.
      const hm = setupDb('hasMany');
      const hmMock = attachStreamMock(hm.db, [
        { OrderCode: 'O1', OrderTitle: 'Order 1' },
        { OrderCode: 'O2', OrderTitle: 'Order 2' },
      ]);
      const allTwentyItems = Array.from({ length: 20 }, (_, i) =>
        hm.orderItems.model.build({ id: i + 1, orderCode: 'O1', sku: `SKU-${i + 1}` }, { isNewRecord: false }),
      );
      const hmLimits: Array<unknown> = [];
      const hmFindSpy = vi
        .spyOn(hm.orderItems.model, 'findAll')
        .mockImplementation(async (opts: Record<string, unknown>) => {
          hmLimits.push(opts.limit);
          const cap = typeof opts.limit === 'number' ? opts.limit : allTwentyItems.length;
          return allTwentyItems.slice(0, cap);
        });
      try {
        await expect(
          (hm.orders.repository as MssqlRepository).chunkWithCursor({
            chunkSize: 1,
            fields: ['code', 'items.sku'],
            callback: async () => undefined,
          }),
        ).rejects.toThrow(
          /Cannot buffer more than 4 related records in memory for a single "orders" record \(association "items"\)/,
        );
        expect(hmLimits).toEqual([5]);
        expect(hmMock.getState()).toEqual({ releasedCount: 1, cancelled: true });
      } finally {
        hmFindSpy.mockRestore();
        await hmMock.cleanup();
      }

      // 2. BelongsToMany: 1 parent with 20 pivots under maxUnkeyedBufferRows=4 bounds pivot query to limit=5 and skips target query.
      const btm = setupDb('belongsToMany');
      const btmMock = attachStreamMock(btm.db, [
        { OrderCode: 'O1', OrderTitle: 'Order 1' },
        { OrderCode: 'O2', OrderTitle: 'Order 2' },
      ]);
      const allTwentyPivots = Array.from({ length: 20 }, (_, i) =>
        btm.orderTags.model.build({ orderCode: 'O1', tagId: i + 1 }, { isNewRecord: false }),
      );
      const pivotLimits: Array<unknown> = [];
      const pivotSpy = vi
        .spyOn(btm.orderTags.model, 'findAll')
        .mockImplementation(async (opts: Record<string, unknown>) => {
          pivotLimits.push(opts.limit);
          const cap = typeof opts.limit === 'number' ? opts.limit : allTwentyPivots.length;
          return allTwentyPivots.slice(0, cap);
        });
      const tagSpy = vi.spyOn(btm.tags.model, 'findAll').mockResolvedValue([]);
      try {
        await expect(
          (btm.orders.repository as MssqlRepository).chunkWithCursor({
            chunkSize: 1,
            fields: ['code', 'tags.label'],
            callback: async () => undefined,
          }),
        ).rejects.toThrow(
          /Cannot buffer more than 4 related records in memory for a single "orders" record \(association "tags"\)/,
        );
        expect(pivotLimits).toEqual([5]);
        expect(tagSpy).not.toHaveBeenCalled();
        expect(btmMock.getState()).toEqual({ releasedCount: 1, cancelled: true });
      } finally {
        pivotSpy.mockRestore();
        tagSpy.mockRestore();
        await btmMock.cleanup();
      }
    });

    it('adaptively splits parent batches when aggregate HasMany/BelongsToMany child count exceeds maxUnkeyedBufferRows', async () => {
      const db = new Database({
        ...formatDatabaseOptions({
          host: 'localhost',
          database: 'sales',
          username: 'sa',
          password: 'secret',
        }),
        mssqlRuntimeOptions: { maxUnkeyedBufferRows: 6 },
        logging: false,
      } as never);
      db.registerRepositories({ 'mssql-repo': MssqlRepository });

      const items = db.collection({
        name: 'order_items',
        tableName: 'OrderItems',
        schema: 'dbo',
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'orderCode', type: 'string' },
          { name: 'sku', type: 'string' },
        ],
      });
      const tags = db.collection({
        name: 'tags',
        tableName: 'Tags',
        schema: 'dbo',
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'label', type: 'string' },
        ],
      });
      const orderTags = db.collection({
        name: 'order_tags',
        tableName: 'OrderTags',
        schema: 'dbo',
        timestamps: false,
        autoGenId: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'orderCode', type: 'string' },
          { name: 'tagId', type: 'integer' },
        ],
      });
      orderTags.model.removeAttribute('id');

      const orders = db.collection({
        name: 'orders',
        tableName: 'Orders',
        schema: 'dbo',
        timestamps: false,
        autoGenId: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'code', field: 'OrderCode', type: 'string' },
          { name: 'items', type: 'hasMany', target: 'order_items', sourceKey: 'code', foreignKey: 'orderCode' },
          {
            name: 'tags',
            type: 'belongsToMany',
            target: 'tags',
            through: 'order_tags',
            sourceKey: 'code',
            foreignKey: 'orderCode',
            otherKey: 'tagId',
            targetKey: 'id',
          },
        ],
      });
      orders.model.removeAttribute('id');

      const orderRows = ['O1', 'O2', 'O3', 'O4'].map((code) => ({ OrderCode: code }));
      const allItems = [
        { id: 1, orderCode: 'O1', sku: 'O1-A' },
        { id: 2, orderCode: 'O1', sku: 'O1-B' },
        { id: 3, orderCode: 'O2', sku: 'O2-A' },
        { id: 4, orderCode: 'O2', sku: 'O2-B' },
        { id: 5, orderCode: 'O3', sku: 'O3-A' },
        { id: 6, orderCode: 'O3', sku: 'O3-B' },
        { id: 7, orderCode: 'O4', sku: 'O4-A' },
        { id: 8, orderCode: 'O4', sku: 'O4-B' },
      ];
      // Shared tag 10 across O1 and O2 validates independent pivot instances on cloned shared targets.
      const allPivots = [
        { orderCode: 'O1', tagId: 10 },
        { orderCode: 'O2', tagId: 10 },
        { orderCode: 'O3', tagId: 20 },
        { orderCode: 'O4', tagId: 20 },
      ];
      const allTags = [
        { id: 10, label: 'VIP' },
        { id: 20, label: 'STD' },
      ];

      const itemFindSpy = vi.spyOn(items.model, 'findAll').mockImplementation(async (opts: Record<string, unknown>) => {
        const whereObj = (opts.where || {}) as { orderCode?: string[] };
        const keys = new Set(Array.isArray(whereObj.orderCode) ? whereObj.orderCode : []);
        const matched = allItems
          .filter((r) => keys.has(r.orderCode))
          .map((r) => items.model.build(r, { isNewRecord: false }));
        const cap = typeof opts.limit === 'number' ? opts.limit : matched.length;
        return matched.slice(0, cap);
      });
      const pivotFindSpy = vi
        .spyOn(orderTags.model, 'findAll')
        .mockImplementation(async (opts: Record<string, unknown>) => {
          const whereObj = (opts.where || {}) as { orderCode?: string[] };
          const keys = new Set(Array.isArray(whereObj.orderCode) ? whereObj.orderCode : []);
          const matched = allPivots
            .filter((r) => keys.has(r.orderCode))
            .map((r) => orderTags.model.build(r, { isNewRecord: false }));
          const cap = typeof opts.limit === 'number' ? opts.limit : matched.length;
          return matched.slice(0, cap);
        });
      const tagFindSpy = vi.spyOn(tags.model, 'findAll').mockImplementation(async (opts: Record<string, unknown>) => {
        const whereObj = (opts.where || {}) as { id?: number[] };
        const keys = new Set(Array.isArray(whereObj.id) ? whereObj.id : []);
        return allTags.filter((r) => keys.has(r.id)).map((r) => tags.model.build(r, { isNewRecord: false }));
      });

      const protoQuerySpy = vi
        .spyOn(Object.getPrototypeOf(db.sequelize), 'query')
        .mockImplementation(async (sql: unknown) => {
          if (typeof sql === 'string' && sql.includes('sys.indexes')) {
            return [[]];
          }
          throw new Error(`Unexpected query: ${String(sql)}`);
        });

      class FourRowRequest {
        private cb: (err?: Error | null, rowCount?: number) => void;
        private listeners: Array<(cols: unknown) => void> = [];
        constructor(_sql: string, cb: (err?: Error | null, rowCount?: number) => void) {
          this.cb = cb;
        }
        on(event: 'row', listener: (cols: unknown) => void) {
          if (event === 'row') this.listeners.push(listener);
          return this;
        }
        pause() {}
        resume() {}
        start() {
          queueMicrotask(() => {
            for (const row of orderRows) {
              for (const l of this.listeners) {
                l([{ value: row.OrderCode, metadata: { colName: 'code', type: { id: 0xe7 } } }]);
              }
            }
            this.cb(null, orderRows.length);
          });
        }
      }

      const connMgr = db.sequelize.connectionManager as unknown as {
        getConnection: (opts: { type?: string }) => Promise<unknown>;
        releaseConnection: (conn: unknown) => Promise<void>;
      };
      const getConnSpy = vi.spyOn(connMgr, 'getConnection').mockResolvedValue({
        lib: { Request: FourRowRequest },
        execSql: (req: FourRowRequest) => req.start(),
      });
      const releaseConnSpy = vi.spyOn(connMgr, 'releaseConnection').mockResolvedValue(undefined);

      const batchSizes: number[] = [];
      const delivered: Array<{ code: string; skus: string[]; tagPivots: Array<{ label: string; orderCode: string }> }> =
        [];
      try {
        await (orders.repository as MssqlRepository).chunkWithCursor({
          chunkSize: 4,
          fields: ['code', 'items.sku', 'tags.label'],
          callback: async (rows) => {
            batchSizes.push(rows.length);
            for (const row of rows) {
              const rowItems = (row.get('items') as Array<{ get: (k: string) => unknown }>) || [];
              const rowTags = (row.get('tags') as Array<{ get: (k: string) => unknown; [k: string]: unknown }>) || [];
              delivered.push({
                code: String(row.get('code')),
                skus: rowItems.map((it) => String(it.get('sku'))),
                tagPivots: rowTags.map((tg) => {
                  const pivot = tg.order_tags as { get: (k: string) => unknown } | undefined;
                  return { label: String(tg.get('label')), orderCode: String(pivot?.get('orderCode')) };
                }),
              });
            }
          },
        });

        expect(batchSizes).toEqual([2, 2]);
        expect(delivered).toEqual([
          { code: 'O1', skus: ['O1-A', 'O1-B'], tagPivots: [{ label: 'VIP', orderCode: 'O1' }] },
          { code: 'O2', skus: ['O2-A', 'O2-B'], tagPivots: [{ label: 'VIP', orderCode: 'O2' }] },
          { code: 'O3', skus: ['O3-A', 'O3-B'], tagPivots: [{ label: 'STD', orderCode: 'O3' }] },
          { code: 'O4', skus: ['O4-A', 'O4-B'], tagPivots: [{ label: 'STD', orderCode: 'O4' }] },
        ]);
      } finally {
        itemFindSpy.mockRestore();
        pivotFindSpy.mockRestore();
        tagFindSpy.mockRestore();
        protoQuerySpy.mockRestore();
        getConnSpy.mockRestore();
        releaseConnSpy.mockRestore();
        await db.close();
      }
    });

    it('bounds HasMany child queries, splits windows, forwards transaction, and rejects recursive includes in fallbackToSingleFind', async () => {
      const db = new Database({
        ...formatDatabaseOptions({
          host: 'localhost',
          database: 'sales',
          username: 'sa',
          password: 'secret',
        }),
        mssqlRuntimeOptions: { maxUnkeyedBufferRows: 4 },
        logging: false,
      } as never);
      db.registerRepositories({ 'mssql-repo': MssqlRepository });

      const orderItems = db.collection({
        name: 'order_items',
        tableName: 'OrderItems',
        schema: 'dbo',
        timestamps: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'orderCode', type: 'string' },
          { name: 'sku', type: 'string' },
        ],
      });
      const orders = db.collection({
        name: 'orders',
        tableName: 'Orders',
        schema: 'dbo',
        timestamps: false,
        autoGenId: false,
        repository: 'mssql-repo',
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'code', field: 'OrderCode', type: 'string' },
          { name: 'title', field: 'OrderTitle', type: 'string' },
          { name: 'parentCode', type: 'string' },
          { name: 'items', type: 'hasMany', target: 'order_items', sourceKey: 'code', foreignKey: 'orderCode' },
          { name: 'parent', type: 'belongsTo', target: 'orders', foreignKey: 'parentCode', targetKey: 'code' },
        ],
      });
      orders.model.removeAttribute('id');

      const protoQuerySpy = vi
        .spyOn(Object.getPrototypeOf(db.sequelize), 'query')
        .mockImplementation(async (sql: unknown) => {
          if (typeof sql === 'string' && sql.includes('sys.indexes')) {
            return [[]];
          }
          throw new Error(`Unexpected raw query: ${String(sql)}`);
        });

      const fakeTx = { id: 'tx-fallback' };
      const parentCalls: Array<{ limit?: unknown; transaction?: unknown; attributes?: unknown }> = [];
      const childCalls: Array<{ limit?: unknown; transaction?: unknown }> = [];

      const twentyChildren = Array.from({ length: 20 }, (_, i) =>
        orderItems.model.build({ id: i + 1, orderCode: 'O1', sku: `SKU-${i + 1}` }, { isNewRecord: false }),
      );

      const parentFindSpy = vi
        .spyOn(orders.model, 'findAll')
        .mockImplementation(async (opts: Record<string, unknown>) => {
          parentCalls.push({ limit: opts.limit, transaction: opts.transaction, attributes: opts.attributes });
          return [orders.model.build({ code: 'O1', title: 'Order 1' }, { isNewRecord: false })];
        });
      const childFindSpy = vi
        .spyOn(orderItems.model, 'findAll')
        .mockImplementation(async (opts: Record<string, unknown>) => {
          childCalls.push({ limit: opts.limit, transaction: opts.transaction });
          const cap = typeof opts.limit === 'number' ? opts.limit : twentyChildren.length;
          return twentyChildren.slice(0, cap);
        });

      const repo = orders.repository as MssqlRepository;
      try {
        // 1. Transaction forces fallbackToSingleFind; limit=1 passes parent check, but HasMany child query is capped at 5 (max+1) and rejected.
        let deliveredAny = false;
        await expect(
          repo.chunk({
            chunkSize: 1,
            limit: 1,
            transaction: fakeTx as never,
            fields: ['title', 'items.sku'],
            callback: async () => {
              deliveredAny = true;
            },
          }),
        ).rejects.toThrow(
          /Cannot buffer more than 4 related records in memory for a single "orders" record \(association "items"\)/,
        );
        expect(deliveredAny).toBe(false);
        expect(parentCalls).toHaveLength(1);
        expect(parentCalls[0]).toMatchObject({ limit: 1, transaction: fakeTx });
        expect(childCalls).toEqual([{ limit: 5, transaction: fakeTx }]);

        // 2. Within budget across split windows inside transaction: 2 parents x 3 children = 6 (> 4), splits to [1, 1] (3 <= 4 each) and strips injected `code`.
        parentCalls.length = 0;
        childCalls.length = 0;
        parentFindSpy.mockImplementation(async (opts: Record<string, unknown>) => {
          parentCalls.push({ limit: opts.limit, transaction: opts.transaction, attributes: opts.attributes });
          return [
            orders.model.build({ code: 'O1', title: 'Order 1' }, { isNewRecord: false }),
            orders.model.build({ code: 'O2', title: 'Order 2' }, { isNewRecord: false }),
          ];
        });
        const sixChildren = [
          { id: 1, orderCode: 'O1', sku: 'O1-1' },
          { id: 2, orderCode: 'O1', sku: 'O1-2' },
          { id: 3, orderCode: 'O1', sku: 'O1-3' },
          { id: 4, orderCode: 'O2', sku: 'O2-1' },
          { id: 5, orderCode: 'O2', sku: 'O2-2' },
          { id: 6, orderCode: 'O2', sku: 'O2-3' },
        ];
        childFindSpy.mockImplementation(async (opts: Record<string, unknown>) => {
          childCalls.push({ limit: opts.limit, transaction: opts.transaction });
          const whereObj = (opts.where || {}) as { orderCode?: string[] };
          const keys = new Set(Array.isArray(whereObj.orderCode) ? whereObj.orderCode : []);
          const matched = sixChildren
            .filter((r) => keys.has(r.orderCode))
            .map((r) => orderItems.model.build(r, { isNewRecord: false }));
          const cap = typeof opts.limit === 'number' ? opts.limit : matched.length;
          return matched.slice(0, cap);
        });

        const batches: Array<Array<{ title: string; skus: string[]; leakedCode: boolean }>> = [];
        await repo.chunk({
          chunkSize: 2,
          limit: 2,
          transaction: fakeTx as never,
          fields: ['title', 'items.sku'],
          callback: async (rows) => {
            batches.push(
              rows.map((r) => ({
                title: String(r.get('title')),
                skus: ((r.get('items') as Model[]) || []).map((it) => String(it.get('sku'))),
                leakedCode: 'code' in r.dataValues,
              })),
            );
          },
        });
        expect(batches).toEqual([
          [{ title: 'Order 1', skus: ['O1-1', 'O1-2', 'O1-3'], leakedCode: false }],
          [{ title: 'Order 2', skus: ['O2-1', 'O2-2', 'O2-3'], leakedCode: false }],
        ]);
        expect(childCalls.every((c) => c.limit === 5 && c.transaction === fakeTx)).toBe(true);

        // 3. Recursive include in transaction is rejected upfront before issuing any root or relation query.
        parentCalls.length = 0;
        childCalls.length = 0;
        await expect(
          repo.chunk({
            chunkSize: 1,
            limit: 1,
            transaction: fakeTx as never,
            appends: ['parent(recursively=true)'],
            callback: async () => undefined,
          }),
        ).rejects.toThrow(/Cannot buffer unbounded related records in memory for collection "orders"/);
        expect(parentCalls).toHaveLength(0);
        expect(childCalls).toHaveLength(0);
      } finally {
        parentFindSpy.mockRestore();
        childFindSpy.mockRestore();
        protoQuerySpy.mockRestore();
        await db.close();
      }
    });
  });
});
