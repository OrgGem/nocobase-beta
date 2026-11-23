// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { MssqlIntrospector } from '../data-source/MssqlIntrospector';

function createIntrospectorHarness(options: {
  describeTableImpl?: (tableInfo: unknown) => Promise<Record<string, Record<string, unknown>>>;
  queryImpl?: (sql: string, opts?: Record<string, unknown>) => Promise<unknown[]>;
}) {
  const describeTable = vi.fn(
    options.describeTableImpl ??
      (async () => ({
        id: { type: 'INT', allowNull: true, defaultValue: null, primaryKey: false, autoIncrement: false },
        title: { type: 'NVARCHAR(100)', allowNull: true, defaultValue: null, primaryKey: false, autoIncrement: false },
      })),
  );
  const query = vi.fn(options.queryImpl ?? (async () => []));
  const escape = (val: unknown) => `'${String(val).replace(/'/g, "''")}'`;

  const db = {
    options: { schema: 'dbo' },
    fieldTypes: new Map(),
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    sequelize: {
      query,
      escape,
      getQueryInterface: () => ({ describeTable }),
    },
  };

  const introspector = new MssqlIntrospector({ db: db as never });
  return { introspector, query, describeTable };
}

describe('MssqlIntrospector safety guarantees', () => {
  it('never fabricates primaryKey=true on a non-unique id column when a physical table has no real PK', async () => {
    const { introspector } = createIntrospectorHarness({
      queryImpl: async () => [],
    });

    const columns = await introspector.getTableColumnsInfo({ tableName: 'audit_logs', schema: 'dbo' });

    expect((columns.id as { primaryKey?: boolean }).primaryKey).toBe(false);
    expect(Object.values(columns).some((c) => Boolean((c as { primaryKey?: boolean }).primaryKey))).toBe(false);
  });

  it('falls back to per-table PK lookup when an uncached table is loaded after a partial preload', async () => {
    const { introspector, query } = createIntrospectorHarness({
      describeTableImpl: async () => ({
        tenant_id: { type: 'INT', allowNull: false, defaultValue: null, primaryKey: false, autoIncrement: false },
        invoice_no: {
          type: 'VARCHAR(32)',
          allowNull: false,
          defaultValue: null,
          primaryKey: false,
          autoIncrement: false,
        },
      }),
      queryImpl: async (sql: string) => {
        if (sql.includes("o.name IN ('orders', 'users')")) {
          return [{ table_name: 'orders', column_name: 'id' }];
        }
        if (sql.includes("o.name = 'invoices'")) {
          return [{ column_name: 'tenant_id' }, { column_name: 'invoice_no' }];
        }
        return [];
      },
    });

    await introspector.preloadAllPrimaryKeys('dbo', ['orders', 'users']);

    // Uncached 3rd table added later must NOT be treated as having no PK.
    const cols = await introspector.getTableColumnsInfo({ tableName: 'invoices', schema: 'dbo' });
    expect((cols.tenant_id as { primaryKey?: boolean }).primaryKey).toBe(true);
    expect((cols.invoice_no as { primaryKey?: boolean }).primaryKey).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('falls back to filtered/disabled-aware sys.indexes query when an uncached table is loaded after a partial index preload', async () => {
    const { introspector, query } = createIntrospectorHarness({
      queryImpl: async (sql: string) => {
        if (sql.includes('i.has_filter = 0') && sql.includes("o.name IN (N'invoices')")) {
          return [
            {
              table_name: 'invoices',
              index_name: 'UQ_invoices_code',
              column_name: 'code',
              key_ordinal: 1,
              is_primary_key: false,
              is_unique: true,
              is_descending_key: false,
            },
          ];
        }
        return [];
      },
    });

    await introspector.preloadAllIndexes('dbo', ['orders', 'users']);

    // Preloaded table with no indexes is served from cache without calling SQL again.
    expect(await introspector.getTableConstraints({ tableName: 'users', schema: 'dbo' })).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);

    // Uncached 3rd table falls back to single-table sys.indexes query (never sp_helpindex) so filtered
    // unique indexes stay excluded and real non-filtered UNIQUE constraints are never silently lost.
    const constraints = await introspector.getTableConstraints({ tableName: 'invoices', schema: 'dbo' });
    expect(constraints).toEqual([
      {
        name: 'UQ_invoices_code',
        primary: false,
        unique: true,
        fields: [{ attribute: 'code', order: 'ASC' }],
      },
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('AND i.has_filter = 0');
    expect(query.mock.calls[1][0]).toContain('AND i.is_disabled = 0');
  });

  it('serves missing tables as empty from cache after a full-schema preload without extra queries', async () => {
    const { introspector, query } = createIntrospectorHarness({
      queryImpl: async () => [{ table_name: 'orders', column_name: 'id' }],
    });

    await introspector.preloadAllPrimaryKeys('dbo');
    await introspector.preloadAllIndexes('dbo');
    expect(query).toHaveBeenCalledTimes(2);

    const cols = await introspector.getTableColumnsInfo({ tableName: 'heap_table', schema: 'dbo' });
    const constraints = await introspector.getTableConstraints({ tableName: 'heap_table', schema: 'dbo' });

    expect((cols.id as { primaryKey?: boolean }).primaryKey).toBe(false);
    expect(constraints).toEqual([]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('invalidates cached columns, PK, and indexes when refreshing a single table', async () => {
    let phase: 'initial' | 'altered' = 'initial';
    const { introspector, describeTable, query } = createIntrospectorHarness({
      describeTableImpl: async () =>
        phase === 'initial'
          ? { id: { type: 'INT', allowNull: false, defaultValue: null, primaryKey: false, autoIncrement: false } }
          : {
              id: { type: 'INT', allowNull: false, defaultValue: null, primaryKey: false, autoIncrement: false },
              code: {
                type: 'VARCHAR(32)',
                allowNull: false,
                defaultValue: null,
                primaryKey: false,
                autoIncrement: false,
              },
            },
      queryImpl: async (sql: string) => {
        if (sql.includes('sys.default_constraints')) {
          return [
            {
              table_name: 'orders',
              column_name: 'id',
              data_type: 'int',
              max_length: 4,
              is_nullable: false,
              is_identity: false,
              default_value: null,
              column_comment: null,
            },
          ];
        }
        if (sql.includes('i.is_primary_key = 1')) {
          return sql.includes("o.name = 'orders'")
            ? [{ column_name: 'id' }]
            : [{ table_name: 'orders', column_name: 'id' }];
        }
        if (sql.includes('i.has_filter = 0')) {
          return phase === 'initial'
            ? []
            : [
                {
                  table_name: 'orders',
                  index_name: 'UQ_orders_code',
                  column_name: 'code',
                  key_ordinal: 1,
                  is_primary_key: false,
                  is_unique: true,
                  is_descending_key: false,
                },
              ];
        }
        return [];
      },
    });

    await introspector.preloadAllColumns('dbo');
    await introspector.preloadAllPrimaryKeys('dbo');
    await introspector.preloadAllIndexes('dbo');
    expect(describeTable).not.toHaveBeenCalled();

    const beforeCols = await introspector.getTableColumnsInfo({ tableName: 'orders', schema: 'dbo' });
    expect(Object.keys(beforeCols)).toEqual(['id']);
    expect(await introspector.getTableConstraints({ tableName: 'orders', schema: 'dbo' })).toEqual([]);

    phase = 'altered';
    introspector.invalidateTables(['orders']);

    const afterCols = await introspector.getTableColumnsInfo({ tableName: 'orders', schema: 'dbo' });
    const afterConstraints = await introspector.getTableConstraints({ tableName: 'orders', schema: 'dbo' });

    expect(describeTable).toHaveBeenCalledTimes(1);
    expect(Object.keys(afterCols)).toEqual(['id', 'code']);
    expect((afterCols.id as { primaryKey?: boolean }).primaryKey).toBe(true);
    expect(afterConstraints).toEqual([
      { name: 'UQ_orders_code', primary: false, unique: true, fields: [{ attribute: 'code', order: 'ASC' }] },
    ]);
    expect(query).toHaveBeenCalled();
  });

  it('re-queries newly created tables after a prior full-schema preload when invalidateTables is called', async () => {
    const { introspector, query } = createIntrospectorHarness({
      queryImpl: async (sql: string) => {
        if (sql.includes('i.is_primary_key = 1') && sql.includes("o.name = 'new_table'")) {
          return [{ column_name: 'id' }];
        }
        if (sql.includes('i.has_filter = 0') && sql.includes("o.name IN (N'new_table')")) {
          return [
            {
              table_name: 'new_table',
              index_name: 'PK_new_table',
              column_name: 'id',
              key_ordinal: 1,
              is_primary_key: true,
              is_unique: true,
              is_descending_key: false,
            },
          ];
        }
        return [];
      },
    });

    await introspector.preloadAllPrimaryKeys('dbo');
    await introspector.preloadAllIndexes('dbo');

    // Loading a brand new table clears the full-schema marker so it isn't masked as index-less/PK-less.
    introspector.invalidateTables(['new_table']);

    const cols = await introspector.getTableColumnsInfo({ tableName: 'new_table', schema: 'dbo' });
    const constraints = await introspector.getTableConstraints({ tableName: 'new_table', schema: 'dbo' });

    expect((cols.id as { primaryKey?: boolean }).primaryKey).toBe(true);
    expect(constraints).toEqual([
      { name: 'PK_new_table', primary: true, unique: true, fields: [{ attribute: 'id', order: 'ASC' }] },
    ]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('marks SQL Server views as read-only ViewCollection metadata via bulk preload and single-object fallback', async () => {
    const { introspector, query } = createIntrospectorHarness({
      queryImpl: async (sql: string, opts?: Record<string, unknown>) => {
        if (sql.includes('sys.default_constraints')) {
          return [
            {
              table_name: 'nb_v_summary',
              object_type: 'V ',
              column_name: 'id',
              data_type: 'int',
              max_length: 4,
              is_nullable: false,
              is_identity: false,
              default_value: null,
              column_comment: null,
            },
            {
              table_name: 'nb_orders',
              object_type: 'U ',
              column_name: 'id',
              data_type: 'int',
              max_length: 4,
              is_nullable: false,
              is_identity: true,
              default_value: null,
              column_comment: null,
            },
          ];
        }
        if (
          sql.includes('FROM sys.views') &&
          (opts?.replacements as { tableName?: string } | undefined)?.tableName === 'v_single'
        ) {
          return [{ is_view: 1 }];
        }
        return [];
      },
    });
    (introspector as unknown as { db: { options: { schema: string; tablePrefix?: string } } }).db.options.tablePrefix =
      'nb_';

    await introspector.preloadAllColumns('dbo');
    await introspector.preloadAllPrimaryKeys('dbo');
    await introspector.preloadAllIndexes('dbo');

    const viewCollection = await introspector.getCollection({
      tableInfo: { tableName: 'nb_v_summary', schema: 'dbo' },
    });
    expect(viewCollection).toMatchObject({
      name: 'v_summary',
      tableName: 'nb_v_summary',
      view: true,
      viewName: 'nb_v_summary',
      template: 'view',
      writableView: false,
      filterTargetKey: 'id',
    });

    const writableView = await introspector.getCollection({
      tableInfo: { tableName: 'nb_v_summary', schema: 'dbo' },
      localOptions: { writableView: true },
    });
    expect(writableView.writableView).toBe(true);

    const tableCollection = await introspector.getCollection({
      tableInfo: { tableName: 'nb_orders', schema: 'dbo' },
    });
    expect(tableCollection.view).toBeUndefined();

    // Single-object fallback after invalidating cache queries sys.views directly.
    introspector.invalidateTables(['v_single']);
    const singleView = await introspector.getCollection({
      tableInfo: { tableName: 'v_single', schema: 'dbo' },
    });
    expect(singleView).toMatchObject({
      name: 'v_single',
      view: true,
      viewName: 'v_single',
      template: 'view',
      writableView: false,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM sys.views'),
      expect.objectContaining({ replacements: { schema: 'dbo', tableName: 'v_single' } }),
    );
  });

  it('preserves allowNull=true for NOT NULL columns with SQL Server DEFAULT constraints while stripping raw SQL expressions', async () => {
    const { introspector } = createIntrospectorHarness({
      describeTableImpl: async () => ({
        Id: {
          type: 'UNIQUEIDENTIFIER',
          allowNull: false,
          defaultValue: '(newid())',
          primaryKey: true,
          autoIncrement: false,
        },
        Status: {
          type: 'INT',
          allowNull: false,
          defaultValue: '((0))',
          primaryKey: false,
          autoIncrement: false,
        },
        CreatedAt: {
          type: 'DATETIME2',
          allowNull: false,
          defaultValue: '(sysutcdatetime())',
          primaryKey: false,
          autoIncrement: false,
        },
        CustomerName: {
          type: 'NVARCHAR(100)',
          allowNull: false,
          defaultValue: null,
          primaryKey: false,
          autoIncrement: false,
        },
        ExplicitNullDefault: {
          type: 'NVARCHAR(50)',
          allowNull: false,
          defaultValue: '(NULL)',
          primaryKey: false,
          autoIncrement: false,
        },
      }),
      queryImpl: async () => [],
    });

    const collection = await introspector.getCollection({
      tableInfo: { tableName: 'Orders', schema: 'dbo' },
    });
    const fieldsByName = Object.fromEntries((collection.fields || []).map((field) => [field.name, field]));

    expect(fieldsByName.Id).toMatchObject({ allowNull: true, autoIncrement: false });
    expect(fieldsByName.Id.defaultValue).toBeUndefined();
    expect(fieldsByName.Status).toMatchObject({ allowNull: true, autoIncrement: false });
    expect(fieldsByName.Status.defaultValue).toBeUndefined();
    expect(fieldsByName.CreatedAt).toMatchObject({ allowNull: true, autoIncrement: false });
    expect(fieldsByName.CreatedAt.defaultValue).toBeUndefined();
    expect(fieldsByName.CustomerName).toMatchObject({ allowNull: false });
    expect(fieldsByName.ExplicitNullDefault).toMatchObject({ allowNull: false });
  });
});
