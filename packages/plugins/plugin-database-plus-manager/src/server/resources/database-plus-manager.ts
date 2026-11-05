/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { ResourceOptions } from '@nocobase/resourcer';
import { NoPermissionError } from '@nocobase/acl';
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
  const standalone = ctx.action.resourceName === 'databasePlusManager';
  const collection = standalone ? String(ctx.action.params.collection || '') : ctx.action.resourceName;
  let params = ctx.action.params;
  if (standalone) {
    if (!collection || collection.includes('.')) ctx.throw(403);
    const acl = ctx.dataSource?.acl || ctx.app.acl;
    const resolved = await acl
      .resolveActionParams(ctx, {
        resourceName: collection,
        actionName: 'list',
        params,
      })
      .catch((error: unknown) => {
        if (error instanceof NoPermissionError) ctx.throw(403);
        throw error;
      });
    params = resolved.mergedParams;
  }
  const requestedMode = mode(params.paginationMode);
  if (requestedMode === 'offset') throw new Error('Use the built-in list action for offset pagination');
  const limitValue = Number(params.limit ?? DEFAULT_LIMIT);
  if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > MAX_LIMIT) throw new Error('Invalid limit');
  const sort = normalizeSort(params.sort);
  const filter = (params.filter ?? {}) as Record<string, unknown>;
  const secret = getSecret(ctx);
  let values: unknown[] = [];
  const token = params.cursor;
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
  const repository = standalone
    ? (ctx.dataSource?.collectionManager || ctx.db).getRepository(collection)
    : ctx.getCurrentRepository();
  const rows = await repository.find({
    context: ctx,
    filter: buildSeekFilter(filter, sort, values),
    fields: params.fields,
    appends: params.appends,
    except: params.except,
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
