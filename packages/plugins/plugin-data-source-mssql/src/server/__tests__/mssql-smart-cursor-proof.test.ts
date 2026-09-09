import { MssqlSmartCursorBuilder } from '../data-source/MssqlSmartCursorBuilder';

function makeSequelize(indexRows: any[]) {
  return { getDialect: () => 'mssql', query: async () => indexRows } as any;
}
const collection = { filterTargetKey: 'id' } as any;

// depth of Op.and nesting
function andDepth(where: any): number {
  const syms = Object.getOwnPropertySymbols(where || {});
  const andSym = syms.find((s) => s.toString() === 'Symbol(and)');
  if (!andSym) return 0;
  const arr = where[andSym] || [];
  return 1 + Math.max(0, ...arr.map(andDepth));
}

describe('where accumulation proof', () => {
  it('single-column cursor does NOT accumulate (shallow merge overwrite)', async () => {
    const sequelize = makeSequelize([
      { INDEX_NAME: 'pk', COLUMN_NAME: 'id', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
    ]);
    const builder = new MssqlSmartCursorBuilder(sequelize, 'T', collection);
    const depths: number[] = [];
    let batch = 0;
    await builder.chunk({
      chunkSize: 2,
      where: { status: 'active' },
      callback: async () => {},
      find: async (opts: any) => {
        depths.push(andDepth(opts.where));
        batch++;
        return batch <= 3 ? [{ id: batch }, { id: batch + 10 }] : [];
      },
    } as any);
    expect(depths).toEqual([0, 0, 0, 0]); // never wraps in Op.and
  });

  it('composite-key cursor NO ACCUMULATION after fix: Op.and nesting stays constant', async () => {
    const sequelize = makeSequelize([
      { INDEX_NAME: 'pk', COLUMN_NAME: 'a', SEQ_IN_INDEX: 1, INDEX_TYPE: 1, DIRECTION: 'ASC' },
      { INDEX_NAME: 'pk', COLUMN_NAME: 'b', SEQ_IN_INDEX: 2, INDEX_TYPE: 1, DIRECTION: 'ASC' },
    ]);
    const builder = new MssqlSmartCursorBuilder(sequelize, 'T', collection);
    const depths: number[] = [];
    let batch = 0;
    await builder.chunk({
      chunkSize: 2,
      where: { status: 'active' },
      callback: async () => {},
      find: async (opts: any) => {
        depths.push(andDepth(opts.where));
        batch++;
        return batch <= 3
          ? [
              { a: batch, b: batch },
              { a: batch + 10, b: batch + 10 },
            ]
          : [];
      },
    } as any);
    // batch1: no Op.and (just base where). Subsequent batches: exactly 1 Op.and level, constant across batches.
    expect(depths).toEqual([0, 1, 1, 1]); // FIXED: no accumulation, constant depth
  });
});
