import { Context, Next } from '@nocobase/actions';
import { COLLECTION, DEFAULT_MAPPING, DEFAULT_SETTINGS } from '../../shared/constants';

export async function ensureSettings(db: any) {
  const repo = db.getRepository(COLLECTION.settings);
  let row = await repo.findOne({});
  if (!row) row = await repo.create({ values: { ...DEFAULT_SETTINGS } });
  return row;
}

export async function ensureDefaultMapping(db: any) {
  const repo = db.getRepository(COLLECTION.mappingProfiles);
  let row = await repo.findOne({ filter: { name: DEFAULT_MAPPING.name } });
  if (!row) row = await repo.create({ values: { ...DEFAULT_MAPPING } });
  return row;
}

function maskSettings(row: any) {
  const data = row?.toJSON ? row.toJSON() : { ...(row || {}) };
  data.callbackApiKeySet = !!data.callbackApiKey;
  delete data.callbackApiKey;
  return data;
}

export async function getSettings(ctx: Context, next: Next) {
  const row = await ensureSettings(ctx.db);
  ctx.body = maskSettings(row);
  await next();
}

export async function saveSettings(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository(COLLECTION.settings);
  const values = { ...(ctx.action.params.values || {}) };
  delete values.callbackApiKeySet;

  const existing = await ensureSettings(ctx.db);
  if (!values.callbackApiKey && existing.callbackApiKey) values.callbackApiKey = existing.callbackApiKey;

  await repo.update({ filterByTk: existing.id, values });
  const saved = await repo.findOne({});
  ctx.body = maskSettings(saved);
  await next();
}

export async function getDefaultMapping(ctx: Context, next: Next) {
  const row = await ensureDefaultMapping(ctx.db);
  ctx.body = row.toJSON();
  await next();
}
