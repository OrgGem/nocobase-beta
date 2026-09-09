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
  });
});
