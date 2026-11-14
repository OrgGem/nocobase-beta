// SPDX-License-Identifier: Apache-2.0

import { Database } from '@nocobase/database';
import { describe, expect, it, vi } from 'vitest';
import { MssqlIntrospector } from '../data-source/MssqlIntrospector';

type CatalogRows = Record<string, { tables: string[]; views: string[] }>;

function createIntrospector(options: { schema?: string; tablePrefix?: string }, catalogRows: CatalogRows) {
  const query = vi.fn(async (sql: string, queryOptions: { replacements?: Record<string, string> }) => {
    const schema = queryOptions.replacements?.schema ?? 'dbo';
    const rows = catalogRows[schema] ?? { tables: [], views: [] };
    return (sql.includes('sys.tables') ? rows.tables : rows.views).map((name) => ({ name }));
  });
  const database = {
    options,
    sequelize: { query },
  };
  const introspector = new MssqlIntrospector({ db: database as unknown as Database });

  return { introspector, query };
}

describe('MSSQL schema-scoped table and view discovery', () => {
  it('filters tables and views to the configured schema before table-prefix filtering', async () => {
    const { introspector, query } = createIntrospector(
      { schema: 'sales', tablePrefix: 'nb_' },
      {
        sales: { tables: ['nb_orders', 'orders', 'nb_shared'], views: ['nb_summary'] },
        dbo: { tables: ['nb_shared', 'nb_users'], views: ['nb_summary', 'nb_dashboard'] },
      },
    );

    await expect(introspector.getTables()).resolves.toEqual(['nb_orders', 'nb_shared', 'nb_summary']);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('sys.tables'),
      expect.objectContaining({ replacements: { schema: 'sales' } }),
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('sys.views'),
      expect.objectContaining({ replacements: { schema: 'sales' } }),
    );
    for (const [sql, queryOptions] of query.mock.calls) {
      expect(sql).toContain('s.name = :schema');
      expect(queryOptions.replacements?.schema).toBe('sales');
    }
  });

  it('defaults an unspecified schema to dbo for both table and view queries', async () => {
    const { introspector, query } = createIntrospector(
      {},
      {
        dbo: { tables: ['shared', 'dbo_only'], views: ['summary'] },
        sales: { tables: ['shared', 'sales_only'], views: ['summary', 'sales_summary'] },
      },
    );

    await expect(introspector.getTables()).resolves.toEqual(['shared', 'dbo_only', 'summary']);

    expect(query).toHaveBeenCalledTimes(2);
    for (const [, queryOptions] of query.mock.calls) {
      expect(queryOptions.replacements?.schema).toBe('dbo');
    }
  });

  it('maps prefixed table names without losing the configured schema', () => {
    const { introspector } = createIntrospector(
      { schema: 'sales', tablePrefix: 'nb_' },
      { sales: { tables: [], views: [] } },
    );

    expect(introspector.tableInfoToCollectionOptions({ tableName: 'nb_orders', schema: 'sales' })).toMatchObject({
      name: 'orders',
      tableName: 'nb_orders',
      schema: 'sales',
    });
  });
});
