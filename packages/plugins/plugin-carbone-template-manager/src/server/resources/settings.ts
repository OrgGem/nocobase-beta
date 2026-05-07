import { Context, Next } from '@nocobase/actions';
import { COLLECTION, DEFAULTS } from '../../shared/constants';
import { CarboneClient } from '../services/carbone-client';

/**
 * Read the singleton settings record. Creates a default row on first access
 * so the UI never sees an empty state.
 */
export async function getSettings(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository(COLLECTION.settings);
  let row = await repo.findOne({});
  if (!row) {
    row = await repo.create({ values: { ...DEFAULTS } });
  }
  // Never expose the raw token to the client; show only whether it is set.
  const data = row.toJSON() as any;
  data.apiTokenSet = !!data.apiToken;
  delete data.apiToken;
  ctx.body = data;
  await next();
}

/**
 * Save the singleton settings record. Empty/undefined `apiToken` keeps the
 * existing value (so users can edit other fields without re-typing the token).
 */
export async function saveSettings(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository(COLLECTION.settings);
  const values = { ...(ctx.action.params.values || {}) };

  // Clean — never let the client write fake tokens through `apiTokenSet`.
  delete values.apiTokenSet;

  const existing = await repo.findOne({});
  if (!values.apiToken && existing?.apiToken) values.apiToken = existing.apiToken;

  if (existing) {
    await repo.update({ filterByTk: existing.id, values });
  } else {
    await repo.create({ values: { ...DEFAULTS, ...values } });
  }

  const saved = await repo.findOne({});
  const json = saved.toJSON() as any;
  json.apiTokenSet = !!json.apiToken;
  delete json.apiToken;
  ctx.body = json;
  await next();
}

/**
 * Ping the configured Carbone endpoint. Used by the "Test connection" button.
 */
export async function testConnection(ctx: Context, next: Next) {
  const repo = ctx.db.getRepository(COLLECTION.settings);
  const row = await repo.findOne({});
  if (!row) {
    ctx.throw(400, 'Carbone settings not configured');
  }

  const overrides = ctx.action.params.values || {};
  const cfg = {
    endpoint: overrides.endpoint ?? row.endpoint,
    apiToken: overrides.apiToken ?? row.apiToken,
    carboneVersion: overrides.carboneVersion ?? row.carboneVersion,
    timeoutMs: overrides.timeoutMs ?? row.timeoutMs ?? DEFAULTS.timeoutMs,
    maxRetries: 0, // fail fast for diagnostics
  };

  const client = new CarboneClient(cfg);
  try {
    const status = await client.status();
    ctx.body = { ok: true, status };
  } catch (err: any) {
    ctx.body = {
      ok: false,
      error: err?.response?.data ?? err?.message ?? String(err),
      statusCode: err?.response?.status,
    };
  }
  await next();
}
