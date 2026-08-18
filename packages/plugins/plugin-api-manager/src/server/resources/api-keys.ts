import type { Application } from '@nocobase/server';
import type { Handlers } from '@nocobase/resourcer';
import { generateApiKey } from '../services/key-manager';

function readBody(ctx: { request?: { body?: unknown } }): Record<string, unknown> {
  const body = ctx.request?.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  return {};
}

function parseScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((s) => String(s).trim()).filter(Boolean);
}

export function registerApiKeysResource(app: Application): void {
  const handlers: Handlers = {
    async create(ctx, next) {
      const body = readBody(ctx);
      const name = String(body.name ?? '').trim();
      if (!name) {
        ctx.throw(400, 'name is required');
      }
      const partnerId = body.partnerId == null || body.partnerId === '' ? null : Number(body.partnerId);
      const scopes = parseScopes(body.scopes);
      const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null;

      const generated = generateApiKey();
      const repo = app.db.getRepository('apiManagerApiKeys');
      const record = await repo.create({
        values: {
          name,
          partnerId,
          keyHash: generated.keyHash,
          keyPrefix: generated.keyPrefix,
          scopes,
          expiresAt,
          enabled: true,
        },
      });

      const json = record.toJSON() as Record<string, unknown>;
      delete json.keyHash;
      ctx.body = { ...json, apiKey: generated.plaintext };
      await next();
    },

    async revoke(ctx, next) {
      const filterByTk = ctx.action?.params?.filterByTk;
      if (filterByTk == null) {
        ctx.throw(400, 'filterByTk is required');
      }
      const repo = app.db.getRepository('apiManagerApiKeys');
      const record = await repo.findOne({ filterByTk });
      if (!record) {
        ctx.throw(404, 'API key not found');
      }
      await repo.update({ filterByTk, values: { enabled: false, revokedAt: new Date() } });
      ctx.body = { ok: true };
      await next();
    },
  };

  app.resourceManager.define({
    name: 'apiManagerApiKeys',
    actions: handlers,
  });
}
