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
    it('ORDER BY index name (alphabetical) and excludes filtered or disabled indexes', async () => {
      const sequelize = makeSequelize([]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', collection);
      await builder.chunk({ chunkSize: 10, callback: async () => {}, find: async () => [] } as any);
      expect(sequelize.calls[0].sql).toMatch(/ORDER BY\s+i\.name/i);
      expect(sequelize.calls[0].sql).toContain('i.has_filter = 0');
      expect(sequelize.calls[0].sql).toContain('i.is_disabled = 0');
      expect(sequelize.calls[0].sql).toContain('c.is_nullable AS IS_NULLABLE');
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

    it('uses single non-offset query with non-unique index ordering when no unique index exists', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'idx_status', COLUMN_NAME: 'status', SEQ_IN_INDEX: 1, INDEX_TYPE: 3, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Users', { filterTargetKey: 'id' });
      const strategy = await (
        builder as unknown as { getBestCursorStrategy(): Promise<unknown> }
      ).getBestCursorStrategy();
      expect(strategy).toBeNull();

      const calls: Array<{ offset?: number; limit?: number; order?: unknown }> = [];
      const delivered: Array<{ status: string; id: number }> = [];
      await builder.chunk({
        chunkSize: 3,
        callback: async (rows: Array<{ status: string; id: number }>) => {
          delivered.push(...rows);
        },
        find: async (opts: { offset?: number; limit?: number; order?: unknown }) => {
          calls.push(opts);
          return [
            { status: 'a', id: 1 },
            { status: 'a', id: 2 },
          ];
        },
      } as never);

      expect(calls).toHaveLength(1);
      expect(calls[0].offset).toBeUndefined();
      expect(calls[0].limit).toBeUndefined();
      expect(calls[0].order).toEqual([['status', 'ASC']]);
      expect(delivered).toEqual([
        { status: 'a', id: 1 },
        { status: 'a', id: 2 },
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

    it('continues past NULL groups in composite ASC cursor without skipping rows', async () => {
      const sequelize = makeSequelize([
        {
          INDEX_NAME: 'ix_status_id',
          COLUMN_NAME: 'status',
          SEQ_IN_INDEX: 1,
          INDEX_TYPE: 2,
          DIRECTION: 'ASC',
          IS_NULLABLE: true,
        },
        {
          INDEX_NAME: 'ix_status_id',
          COLUMN_NAME: 'id',
          SEQ_IN_INDEX: 2,
          INDEX_TYPE: 2,
          DIRECTION: 'ASC',
          IS_NULLABLE: false,
        },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Orders', collection);

      const seenWheres: any[] = [];
      const delivered: Array<{ status: string | null; id: number }> = [];
      const batches = [
        [
          { status: null, id: 1 },
          { status: null, id: 2 },
        ],
        [
          { status: null, id: 3 },
          { status: 'active', id: 4 },
        ],
        [{ status: 'closed', id: 5 }],
      ];
      let call = 0;

      await builder.chunk({
        chunkSize: 2,
        callback: async (rows: any[]) => {
          delivered.push(...rows);
        },
        find: async (opts: any) => {
          seenWheres.push(opts.where);
          return batches[call++] ?? [];
        },
      } as any);

      expect(seenWheres[1]).toEqual({
        [Op.or]: [{ status: { [Op.not]: null } }, { status: { [Op.is]: null }, id: { [Op.gt]: 2 } }],
      });
      expect(seenWheres[2]).toEqual({
        [Op.or]: [{ status: { [Op.gt]: 'active' } }, { status: 'active', id: { [Op.gt]: 4 } }],
      });
      expect(delivered.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    });

    it('handles NULL ordering cleanly in DESC composite and single nullable cursors', async () => {
      const sequelize = makeSequelize([
        {
          INDEX_NAME: 'ix_status_desc',
          COLUMN_NAME: 'status',
          SEQ_IN_INDEX: 1,
          INDEX_TYPE: 2,
          DIRECTION: 'DESC',
          IS_NULLABLE: true,
        },
        {
          INDEX_NAME: 'ix_status_desc',
          COLUMN_NAME: 'id',
          SEQ_IN_INDEX: 2,
          INDEX_TYPE: 2,
          DIRECTION: 'ASC',
          IS_NULLABLE: false,
        },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Orders', collection);
      const strategy = await (builder as any).getBestCursorStrategy();

      // In DESC with nullable leading column, non-null cursor must still allow trailing NULL rows.
      const afterNonNull = strategy.buildWhere(undefined, { status: 'active', id: 2 });
      expect(afterNonNull).toEqual({
        [Op.or]: [
          { status: { [Op.or]: [{ [Op.lt]: 'active' }, { [Op.is]: null }] } },
          { status: 'active', id: { [Op.gt]: 2 } },
        ],
      });

      // In DESC at NULL group, impossible `status < null` branch is omitted and only `status IS NULL AND id > 2` remains.
      const afterNull = strategy.buildWhere(undefined, { status: null, id: 2 });
      expect(afterNull).toEqual({ status: { [Op.is]: null }, id: { [Op.gt]: 2 } });

      // Single nullable DESC column ending at NULL must stop cleanly without issuing another query.
      const singleDescSeq = makeSequelize([
        {
          INDEX_NAME: 'uq_email_desc',
          COLUMN_NAME: 'email',
          SEQ_IN_INDEX: 1,
          INDEX_TYPE: 2,
          DIRECTION: 'DESC',
          IS_NULLABLE: true,
        },
      ]);
      const singleBuilder = new MssqlSmartCursorBuilder(singleDescSeq, 'Users', collection);
      const findSpy = vi.fn(async () => [{ email: null }]);
      await singleBuilder.chunk({
        chunkSize: 1,
        callback: async () => {},
        find: findSpy,
      } as any);
      expect(findSpy).toHaveBeenCalledTimes(1);
    });

    it('temporarily selects omitted or excluded cursor columns across all batches and strips them before callback', async () => {
      const sequelize = makeSequelize([
        { INDEX_NAME: 'pk_orders', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      ]);
      const builder = new MssqlSmartCursorBuilder(sequelize, 'Orders', collection);

      const allRows = [
        { id: 1, title: 'one' },
        { id: 2, title: 'two' },
        { id: 3, title: 'three' },
        { id: 4, title: 'four' },
        { id: 5, title: 'five' },
      ];

      const makeModelRow = (row: Record<string, unknown>) => {
        const dataValues = { ...row };
        const _previousDataValues = { ...row };
        return {
          dataValues,
          _previousDataValues,
          getDataValue: (k: string) => dataValues[k],
          get: (k: string) => dataValues[k],
        };
      };

      const simulateFind = (opts: {
        fields?: string[];
        except?: string[];
        attributes?: string[] | { exclude?: string[] };
        where?: { id?: Record<symbol, number> };
        limit?: number;
      }) => {
        const afterId = opts.where?.id?.[Op.gt] ?? 0;
        const selected = allRows.filter((r) => r.id > afterId).slice(0, opts.limit ?? 2);
        return selected.map((row) => {
          const picked: Record<string, unknown> = {};
          const keys = Array.isArray(opts.attributes)
            ? opts.attributes
            : Array.isArray(opts.fields)
              ? opts.fields
              : Object.keys(row).filter(
                  (k) =>
                    !(Array.isArray(opts.except) && opts.except.includes(k)) &&
                    !(
                      opts.attributes &&
                      !Array.isArray(opts.attributes) &&
                      Array.isArray(opts.attributes.exclude) &&
                      opts.attributes.exclude.includes(k)
                    ),
                );
          for (const k of keys) {
            if (k in row) picked[k] = row[k as keyof typeof row];
          }
          return makeModelRow(picked);
        });
      };

      // Case 1: fields omits cursor column `id`
      const deliveredFromFields: Array<Record<string, unknown>> = [];
      const seenFieldsOpts: Array<Record<string, unknown>> = [];
      await builder.chunk({
        chunkSize: 2,
        fields: ['title'],
        find: async (opts: any) => {
          seenFieldsOpts.push(opts);
          return simulateFind(opts);
        },
        callback: async (rows: any[]) => {
          deliveredFromFields.push(...rows.map((r) => ({ ...r.dataValues })));
        },
      } as any);
      expect(seenFieldsOpts[0].fields).toEqual(['title', 'id']);
      expect(deliveredFromFields).toEqual([
        { title: 'one' },
        { title: 'two' },
        { title: 'three' },
        { title: 'four' },
        { title: 'five' },
      ]);

      // Case 2: except excludes cursor column `id`
      const deliveredFromExcept: Array<Record<string, unknown>> = [];
      await builder.chunk({
        chunkSize: 2,
        except: ['id'],
        find: async (opts: any) => simulateFind(opts),
        callback: async (rows: any[]) => {
          deliveredFromExcept.push(...rows.map((r) => ({ ...r.dataValues })));
        },
      } as any);
      expect(deliveredFromExcept).toEqual([
        { title: 'one' },
        { title: 'two' },
        { title: 'three' },
        { title: 'four' },
        { title: 'five' },
      ]);

      // Case 3: attributes array omits `id` and attributes.exclude omits `id`
      const deliveredFromAttrArray: Array<Record<string, unknown>> = [];
      await builder.chunk({
        chunkSize: 2,
        attributes: ['title'],
        find: async (opts: any) => simulateFind(opts),
        callback: async (rows: any[]) => {
          deliveredFromAttrArray.push(...rows.map((r) => ({ ...r.dataValues })));
        },
      } as any);
      expect(deliveredFromAttrArray).toHaveLength(5);
      expect(deliveredFromAttrArray.every((r) => !('id' in r))).toBe(true);

      const deliveredFromAttrExclude: Array<Record<string, unknown>> = [];
      await builder.chunk({
        chunkSize: 2,
        attributes: { exclude: ['id'] },
        find: async (opts: any) => simulateFind(opts),
        callback: async (rows: any[]) => {
          deliveredFromAttrExclude.push(...rows.map((r) => ({ ...r.dataValues })));
        },
      } as any);
      expect(deliveredFromAttrExclude).toHaveLength(5);
      expect(deliveredFromAttrExclude.every((r) => !('id' in r))).toBe(true);
    });

    it('avoids multi-query OFFSET drift on duplicate rows by reading once without offset when no unique key exists', async () => {
      const sequelize = makeSequelize([]);
      const pkLessCollection = {
        filterTargetKey: undefined as unknown as string,
        model: {
          rawAttributes: {
            code: { field: 'ItemCode' },
            title: { field: 'ItemTitle' },
          },
        },
      };
      const builder = new MssqlSmartCursorBuilder(sequelize, 'AuditItems', pkLessCollection);
      const strategy = await builder.getBestCursorStrategy();
      expect(strategy).toBeNull();

      // Adversarial mock simulating unstable scan order across separate SQL queries on duplicate keys:
      // if chunk() ever re-queries with OFFSET, it throws or permutes duplicate 'A' rows.
      const scanSnapshot = [
        { code: 'A', title: 'first' },
        { code: 'A', title: 'second' },
        { code: 'A', title: 'third' },
        { code: 'B', title: 'fourth' },
        { code: 'B', title: 'fifth' },
      ];
      let findCallCount = 0;
      const seenOffsets: Array<number | undefined> = [];
      const batchSizes: number[] = [];
      const delivered: Array<{ code: string; title: string }> = [];

      await builder.chunk({
        chunkSize: 2,
        find: async (opts: { offset?: number; limit?: number }) => {
          findCallCount += 1;
          seenOffsets.push(opts.offset);
          if (opts.offset !== undefined) {
            throw new Error(`Unexpected OFFSET query (offset=${opts.offset}) on unique-less table`);
          }
          if (findCallCount === 1) {
            return scanSnapshot;
          }
          // Simulated shifted duplicate order if a 2nd scan had occurred
          return [scanSnapshot[2], scanSnapshot[0], scanSnapshot[1], scanSnapshot[4], scanSnapshot[3]];
        },
        callback: async (rows: Array<{ code: string; title: string }>) => {
          batchSizes.push(rows.length);
          delivered.push(...rows);
        },
      } as never);

      expect(findCallCount).toBe(1);
      expect(seenOffsets).toEqual([undefined]);
      expect(batchSizes).toEqual([2, 2, 1]);
      expect(delivered).toEqual(scanSnapshot);
    });

    it('delegates single-query execution to options.stream and honors overall limit when no unique key exists', async () => {
      const sequelize = makeSequelize([]);
      const pkLessCollection = {
        filterTargetKey: undefined as unknown as string,
        model: {
          rawAttributes: {
            code: { field: 'ItemCode' },
            title: { field: 'ItemTitle' },
          },
        },
      };
      const builder = new MssqlSmartCursorBuilder(sequelize, 'AuditItems', pkLessCollection);
      const findSpy = vi.fn();
      const streamCalls: Array<{ offset?: number; limit?: number }> = [];
      const hookOrder: string[] = [];
      const delivered: Array<{ code: string; title: string }> = [];

      await builder.chunk({
        chunkSize: 2,
        limit: 3,
        find: findSpy,
        beforeFind: async () => {
          hookOrder.push('beforeFind');
        },
        afterFind: async (rows: Array<{ code: string; title: string }>) => {
          hookOrder.push(`afterFind:${rows.length}`);
        },
        stream: async (queryOpts, onBatch) => {
          streamCalls.push({ offset: queryOpts.offset, limit: queryOpts.limit });
          await onBatch(
            [
              { code: 'A', title: 'first' },
              { code: 'A', title: 'second' },
            ] as never,
            queryOpts,
          );
          await onBatch([{ code: 'A', title: 'third' }] as never, queryOpts);
        },
        callback: async (rows: Array<{ code: string; title: string }>) => {
          hookOrder.push(`callback:${rows.length}`);
          delivered.push(...rows);
        },
      });

      expect(findSpy).not.toHaveBeenCalled();
      expect(streamCalls).toEqual([{ offset: undefined, limit: 3 }]);
      expect(delivered).toEqual([
        { code: 'A', title: 'first' },
        { code: 'A', title: 'second' },
        { code: 'A', title: 'third' },
      ]);
      expect(hookOrder).toEqual(['beforeFind', 'afterFind:2', 'callback:2', 'beforeFind', 'afterFind:1', 'callback:1']);
    });
  });
});
