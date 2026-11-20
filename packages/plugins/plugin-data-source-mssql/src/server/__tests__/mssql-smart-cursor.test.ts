/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { MssqlSmartCursorBuilder } from '../data-source/MssqlSmartCursorBuilder';
import { Op } from 'sequelize';

// Minimal sequelize stub capturing the SQL + replacements actually issued.
function makeSequelize(indexRows: any[]) {
  const calls: any[] = [];
  return {
    calls,
    getDialect: () => 'mssql',
    query: async (sql: string, opts: any) => {
      calls.push({ sql, replacements: opts.replacements });
      return indexRows;
    },
  } as any;
}

const collection = { filterTargetKey: 'id' } as any;

describe('MssqlSmartCursorBuilder', () => {
  describe('getBestCursorStrategy index SQL', () => {
    it('passes the bracket-quoted table name (no schema) to OBJECT_ID', async () => {
      const sequelize = makeSequelize([]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);
      await builder.chunk({ chunkSize: 10, callback: async () => {}, find: async () => [] } as any);
      expect(sequelize.calls[0].replacements).toEqual(['[Users]']);
    });

    it('passes schema-qualified bracket-quoted name to OBJECT_ID when schema is given', async () => {
      const sequelize = makeSequelize([]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Clients', collection, 'identity');
      await builder.chunk({ chunkSize: 10, callback: async () => {}, find: async () => [] } as any);
      expect(sequelize.calls[0].replacements).toEqual(['[identity].[Clients]']);
    });

    it('escapes a closing bracket in table or schema name', async () => {
      const sequelize = makeSequelize([]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'we]ird', collection, 'sch]ema');
      await builder.chunk({ chunkSize: 10, callback: async () => {}, find: async () => [] } as any);
      expect(sequelize.calls[0].replacements).toEqual(['[sch]]ema].[we]]ird]']);
    });
    it('ORDER BY index name (alphabetical), not by primary/unique priority', async () => {
      const sequelize = makeSequelize([]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);
      await builder.chunk({ chunkSize: 10, callback: async () => {}, find: async () => [] } as any);
      expect(sequelize.calls[0].sql).toMatch(/ORDER BY\s+i\.name/i);
    });

    it('still picks the PRIMARY KEY index even when a non-PK index sorts first alphabetically', async () => {
      // aaa_idx (non-unique, column nonUniqueCol) sorts before pk_users (PK, column id)
      const rows = [
        { INDEX_NAME: 'aaa_idx', COLUMN_NAME: 'nonUniqueCol', SEQ_IN_INDEX: 1, INDEX_TYPE: 3, DIRECTION: 'ASC' },
        { INDEX_NAME: 'pk_users', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ];
      const sequelize = makeSequelize(rows);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);
      const strategy = await (builder as any).getBestCursorStrategy();
      expect(strategy.columnName).toBe('id');
    });

    it('orders composite index columns via sparse key_ordinal assignment', async () => {
      // Composite PK out of row order: key_ordinal 2 arrives before 1
      const rows = [
        { INDEX_NAME: 'pk_c', COLUMN_NAME: 'b', SEQ_IN_INDEX: 2, INDEX_TYPE: 1, DIRECTION: 'ASC' },
        { INDEX_NAME: 'pk_c', COLUMN_NAME: 'a', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ];
      const sequelize = makeSequelize(rows);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);
      const strategy = await (builder as any).getBestCursorStrategy();
      expect(strategy.buildSort()).toEqual([
        ['a', 'ASC'],
        ['b', 'ASC'],
      ]);
    });
  });

  describe('chunk() where accumulation across batches', () => {
    // 3 batches: batch1 full, batch2 full, batch3 empty -> where wrapped twice
    it('nests the user where deeper on every subsequent batch', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'pk_users', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);

      const seenWheres: any[] = [];
      let batch = 0;
      await builder.chunk({
        chunkSize: 2,
        where: { status: 'active' },
        callback: async () => {},
        find: async (opts: any) => {
          seenWheres.push(
            JSON.parse(JSON.stringify(opts.where ?? {}, (k, v) => (typeof v === 'symbol' ? v.toString() : v))),
          );
          batch++;
          if (batch === 1) return [{ id: 1 }, { id: 2 }];
          if (batch === 2) return [{ id: 3 }, { id: 4 }];
          return [];
        },
      } as any);

      // batch1: plain user where
      expect(seenWheres[0]).toEqual({ status: 'active' });
      // batch2: user where + id>2 merged at top level (SingleColumn strategy shallow-merges)
      expect(seenWheres[1]).toMatchObject({ status: 'active' });
    });

    it('uses Op.lt for DESC indexes (single and composite) instead of Op.gt', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'pk_desc', COLUMN_NAME: 'created_at', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'DESC' },
        { INDEX_NAME: 'pk_desc', COLUMN_NAME: 'id', SEQ_IN_INDEX: 2, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Events', collection);
      const strategy = await (builder as any).getBestCursorStrategy();

      expect(strategy.buildSort()).toEqual([
        ['created_at', 'DESC'],
        ['id', 'ASC'],
      ]);

      const nextWhere = strategy.buildWhere(undefined, { created_at: '2026-01-10', id: 50 });
      expect(nextWhere[Op.or]).toEqual([
        { created_at: { [Op.lt]: '2026-01-10' } },
        { created_at: '2026-01-10', id: { [Op.gt]: 50 } },
      ]);
    });

    it('preserves user filter on cursor column via Op.and instead of overwriting it', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'pk_users', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);
      const strategy = await (builder as any).getBestCursorStrategy();

      const nextWhere = strategy.buildWhere({ id: { [Op.lte]: 1000 } }, { id: 100 });
      expect(nextWhere[Op.and]).toEqual([{ id: { [Op.lte]: 1000 } }, { id: { [Op.gt]: 100 } }]);
    });

    it('appends filterTargetKey tie-breaker to non-unique index and stops early when batch < chunkSize', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'idx_status', COLUMN_NAME: 'status', SEQ_IN_INDEX: 1, INDEX_TYPE: 3, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', { filterTargetKey: 'id' });
      const calls: any[] = [];

      await builder.chunk({
        chunkSize: 3,
        callback: async () => {},
        find: async (opts: any) => {
          calls.push(opts);
          return calls.length === 1
            ? [
                { status: 'a', id: 1 },
                { status: 'a', id: 2 },
              ]
            : [];
        },
      } as any);

      // Should stop after 1st batch (2 < chunkSize 3) without issuing a redundant 2nd query
      expect(calls).toHaveLength(1);
      expect(calls[0].order).toEqual([
        ['status', 'ASC'],
        ['id', 'ASC'],
      ]);
    });

    it('caches index metadata across multiple chunk() calls', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'pk_users', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);

      await builder.chunk({ chunkSize: 10, callback: async () => {}, find: async () => [] } as any);
      await builder.chunk({ chunkSize: 10, callback: async () => {}, find: async () => [] } as any);

      expect(sequelize.calls).toHaveLength(1);
    });

    it('honors overall options.limit (e.g. EXPORT_LIMIT) across batches without exceeding it', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'pk_users', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);

      const allRows = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));
      const requestedLimits: number[] = [];
      const delivered: number[] = [];

      await builder.chunk({
        chunkSize: 2,
        limit: 5,
        callback: async (rows: any[]) => {
          delivered.push(...rows.map((r) => r.id));
        },
        find: async (opts: any) => {
          requestedLimits.push(opts.limit);
          const afterId = opts.where?.id?.[Op.gt] ?? 0;
          return allRows.filter((r) => r.id > afterId).slice(0, opts.limit);
        },
      } as any);

      expect(requestedLimits).toEqual([2, 2, 1]);
      expect(delivered).toEqual([1, 2, 3, 4, 5]);
    });

    it('exits immediately without querying when options.limit is 0 or negative', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'pk_users', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);

      let findCalls = 0;
      let callbackCalls = 0;
      await builder.chunk({
        chunkSize: 200,
        limit: 0,
        callback: async () => {
          callbackCalls++;
        },
        find: async () => {
          findCalls++;
          return [{ id: 1 }];
        },
      } as any);

      expect(sequelize.calls).toHaveLength(0);
      expect(findCalls).toBe(0);
      expect(callbackCalls).toBe(0);
    });

    it('maps physical COLUMN_NAME from sys.columns to Sequelize attribute name and stops safely if cursor value is missing', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'pk_orders', COLUMN_NAME: 'Order_ID', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ]);
      const mappedCollection = {
        filterTargetKey: 'orderId',
        model: {
          rawAttributes: {
            orderId: { field: 'Order_ID' },
          },
        },
      };
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Orders', mappedCollection);

      const seenOpts: any[] = [];
      let batch = 0;
      await builder.chunk({
        chunkSize: 2,
        callback: async () => {},
        find: async (opts: any) => {
          seenOpts.push(opts);
          batch++;
          if (batch === 1) {
            return [
              { get: (k: string) => (k === 'orderId' ? 10 : undefined) },
              { get: (k: string) => (k === 'orderId' ? 20 : undefined) },
            ];
          }
          // Missing cursor attribute on next batch must stop cleanly instead of looping forever.
          return [{ title: 'no-pk-1' }, { title: 'no-pk-2' }];
        },
      } as any);

      expect(seenOpts).toHaveLength(2);
      expect(seenOpts[0].order).toEqual([['orderId', 'ASC']]);
      expect(seenOpts[1].where).toEqual({ orderId: { [Op.gt]: 20 } });
    });
  });
});
