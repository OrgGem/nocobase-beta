import {
  type IndexAttribute,
  addIndex as createIndex,
  listIndexes as fetchIndexes,
  removeIndex as dropIndex,
} from '../utils/indexes';
import { readParam } from '../utils/params';

function normalizeFields(input: unknown): IndexAttribute[] {
  const list = Array.isArray(input) ? input : [input];
  return (list.filter(Boolean) as unknown[]).map<IndexAttribute>((field) => {
    if (typeof field === 'string') return field;
    const record = field as Record<string, unknown>;
    return { attribute: String(record.attribute ?? record.field ?? field) };
  });
}

export async function listIndexes(ctx, next) {
  const tableName = readParam<string>(ctx, 'tableName') || readParam<string>(ctx, 'collection');
  if (!tableName) throw new Error('A table name is required');
  const indexes = await fetchIndexes(ctx.db, tableName);
  ctx.body = { indexes };
  await next();
}

export async function addIndex(ctx, next) {
  const tableName = readParam<string>(ctx, 'tableName') || readParam<string>(ctx, 'collection');
  const name = readParam<string>(ctx, 'name');
  if (!tableName) throw new Error('A table name is required');
  if (!name) throw new Error('An index name is required');

  const fields = normalizeFields(readParam<unknown>(ctx, 'fields', []));
  if (!fields.length) throw new Error('At least one column is required');

  await createIndex(ctx.db, tableName, { name, fields });

  ctx.body = { ok: true };
  await next();
}

export async function removeIndex(ctx, next) {
  const tableName = readParam<string>(ctx, 'tableName') || readParam<string>(ctx, 'collection');
  const indexName = readParam<string>(ctx, 'indexName') || readParam<string>(ctx, 'name');
  if (!tableName) throw new Error('A table name is required');
  if (!indexName) throw new Error('An index name is required');

  await dropIndex(ctx.db, tableName, indexName);

  ctx.body = { ok: true };
  await next();
}
