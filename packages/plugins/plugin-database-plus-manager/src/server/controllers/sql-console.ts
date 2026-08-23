import { QueryTypes } from 'sequelize';
import { MAX_ROWS, assertSafeSelect, limitRows } from '../utils/sql-safety';
import { readParam } from '../utils/params';

export async function runSql(ctx, next) {
  const sql = readParam<string>(ctx, 'sql');
  const statement = assertSafeSelect(sql);

  const transaction = await ctx.db.sequelize.transaction();
  try {
    const rows = await ctx.db.sequelize.query(limitRows(statement), {
      type: QueryTypes.SELECT,
      transaction,
    });
    ctx.body = { rows, rowCount: Array.isArray(rows) ? rows.length : 0, limit: MAX_ROWS };
  } finally {
    await transaction.rollback();
  }

  await next();
}
