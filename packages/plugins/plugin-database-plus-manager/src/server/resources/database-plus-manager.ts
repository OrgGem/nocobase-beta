import { ResourceOptions } from '@nocobase/resourcer';
import { createCursor, parseCursor } from '../utils/cursor';
import { buildSeekFilter } from '../utils/keyset';
import { hashFilter, normalizeSort } from '../utils/sort';
import { aggregate } from '../controllers/aggregate';
import { addIndex, listIndexes, removeIndex } from '../controllers/indexes';
import { runSql } from '../controllers/sql-console';
import { statistics } from '../controllers/statistics';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_MODE = 'offset';

type PaginationMode = 'offset' | 'keyset' | 'cursor';

function mode(value: unknown): PaginationMode {
  if (value === 'offset' || value === 'keyset' || value === 'cursor') return value;
  return DEFAULT_MODE;
}

function modelValue(row: unknown, field: string): unknown {
  if (typeof row === 'object' && row !== null && 'get' in row && typeof row.get === 'function') {
    return row.get(field.replace(/^[+-]/, ''));
  }
  return undefined;
}

function getSecret(ctx: { app?: { secret?: unknown } }): string {
  return String(ctx.app?.secret || process.env.NC_APP_SECRET || 'database-plus-manager');
}

export async function cursorPaginationAction(ctx, next) {
  const requestedMode = mode(ctx.action.params.paginationMode);
  if (requestedMode === 'offset') throw new Error('Use the built-in list action for offset pagination');
  const limitValue = Number(ctx.action.params.limit ?? DEFAULT_LIMIT);
  if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > MAX_LIMIT) throw new Error('Invalid limit');
  const sort = normalizeSort(ctx.action.params.sort);
  const collection = String(ctx.action.params.collection || ctx.action.resourceName);
  const filter = (ctx.action.params.filter ?? {}) as Record<string, unknown>;
  const secret = getSecret(ctx);
  let values: unknown[] = [];
  const token = ctx.action.params.cursor;
  if (token) {
    const payload = parseCursor(String(token), secret);
    if (
      payload.collection !== collection ||
      payload.sort.join(',') !== sort.join(',') ||
      payload.filterHash !== hashFilter(filter)
    ) {
      throw new Error('Cursor does not match this query');
    }
    values = payload.values;
  }
  const repository = ctx.db.getRepository(collection);
  const rows = await repository.find({
    context: ctx,
    filter: buildSeekFilter(filter, sort, values),
    fields: ctx.action.params.fields,
    appends: ctx.action.params.appends,
    except: ctx.action.params.except,
    sort,
    limit: limitValue + 1,
  });
  const page = rows.slice(0, limitValue);
  const last = page[page.length - 1];
  const hasNext = rows.length > limitValue;
  const nextCursor =
    hasNext && last
      ? createCursor(
          {
            v: 1,
            collection,
            sort,
            values: sort.map((field) => modelValue(last, field)),
            filterHash: hashFilter(filter),
            exp: Date.now() + 15 * 60 * 1000,
          },
          secret,
        )
      : null;
  ctx.body = { rows: page, nextCursor, hasNext, limit: limitValue, sort, mode: requestedMode };
  await next();
}

const resource: ResourceOptions = {
  name: 'databasePlusManager',
  actions: {
    async getSettings(ctx, next) {
      const repo = ctx.db.getRepository('databasePlusManagerSettings');
      let row = await repo.findOne();
      if (!row) row = await repo.create({ values: { paginationMode: DEFAULT_MODE } });
      ctx.body = { paginationMode: mode(row.get('paginationMode')) };
      await next();
    },
    async saveSettings(ctx, next) {
      const value = ctx.action.params.values?.paginationMode ?? ctx.request.body?.paginationMode;
      const paginationMode = mode(value);
      if (value !== undefined && value !== paginationMode) throw new Error('Invalid pagination mode');
      const repo = ctx.db.getRepository('databasePlusManagerSettings');
      const row = await repo.findOne();
      if (row) await row.update({ paginationMode });
      else await repo.create({ values: { paginationMode } });
      ctx.body = { paginationMode };
      await next();
    },
    cursor: cursorPaginationAction,
    statistics,
    listIndexes,
    addIndex,
    removeIndex,
    runSql,
    aggregate,
  },
};

export default resource;
