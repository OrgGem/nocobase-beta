// SPDX-License-Identifier: Apache-2.0

import { Op } from 'sequelize';
import { describe, expect, it, vi } from 'vitest';
import { MssqlRepository } from '../data-source/MssqlRepository';

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
});
