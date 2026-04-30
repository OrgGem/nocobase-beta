import { Context, Next } from '@nocobase/actions';

const CONFIG_KEY = 'drawioBaseUrl';

async function readStoredBaseUrl(ctx: Context): Promise<string | null> {
  try {
    const repo = ctx.db.getRepository<any>('aiDrawioConfig');
    if (!repo) return null;
    const row = await repo.findOne({ filter: { key: CONFIG_KEY } });
    return row?.get('value') ?? null;
  } catch {
    return null;
  }
}

export async function getConfig(ctx: Context, next: Next) {
  const stored = await readStoredBaseUrl(ctx);
  ctx.body = {
    drawioBaseUrl: stored || process.env.DRAWIO_BASE_URL || '',
    fromEnv: !stored && !!process.env.DRAWIO_BASE_URL,
  };
  await next();
}

export async function setConfig(ctx: Context, next: Next) {
  const body = (ctx.request as any).body || {};
  const url = typeof body === 'string' ? body : body.drawioBaseUrl;
  if (typeof url !== 'string' || !url.trim()) {
    ctx.throw(400, 'drawioBaseUrl is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    ctx.throw(400, 'drawioBaseUrl must be a valid URL');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    ctx.throw(400, 'drawioBaseUrl must use http:// or https://');
  }
  const repo = ctx.db.getRepository<any>('aiDrawioConfig');
  if (!repo) {
    ctx.throw(500, 'aiDrawioConfig collection not registered');
  }

  const existing = await repo.findOne({ filter: { key: CONFIG_KEY } });
  if (existing) {
    await repo.update({ filter: { key: CONFIG_KEY }, values: { value: url } });
  } else {
    await repo.create({ values: { key: CONFIG_KEY, value: url } });
  }

  ctx.body = { drawioBaseUrl: url };
  await next();
}
