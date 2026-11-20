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

  it('falls back to sp_helpindex when an uncached table is loaded after a partial index preload', async () => {
    const { introspector, query } = createIntrospectorHarness({
      queryImpl: async (sql: string) => {
        if (sql.includes('EXEC sys.sp_helpindex')) {
          return [{ name: 'UQ_invoices_code', unique: true, primary: false, fields: [{ attribute: 'code' }] }];
        }
        return [];
      },
    });

    await introspector.preloadAllIndexes('dbo', ['orders', 'users']);

    // Preloaded table with no indexes is served from cache without calling sp_helpindex.
    expect(await introspector.getTableConstraints({ tableName: 'users', schema: 'dbo' })).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);

    // Uncached 3rd table falls back to sp_helpindex so UNIQUE constraints are never silently lost.
    const constraints = await introspector.getTableConstraints({ tableName: 'invoices', schema: 'dbo' });
    expect(constraints).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('EXEC sys.sp_helpindex');
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
});
