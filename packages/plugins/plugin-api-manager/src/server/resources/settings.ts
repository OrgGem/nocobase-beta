import type { Context } from '@nocobase/actions';
import type { Application } from '@nocobase/server';
import type { Handlers } from '@nocobase/resourcer';

export function registerApiManagerSettingsResource(app: Application): void {
  const handlers: Handlers = {
    async get(ctx: Context, next) {
      const repo = app.db.getRepository('apiManagerSettings');
      const row = await repo.findOne({});
      ctx.body = row?.toJSON?.() ?? null;
      await next();
    },
    async save(ctx: Context, next) {
      const repo = app.db.getRepository('apiManagerSettings');
      const incoming = (ctx.action?.params?.values ?? {}) as Record<string, unknown>;
      const existing = await repo.findOne({});
      if (existing) {
        await repo.update({ filterByTk: existing.get('id'), values: incoming });
      } else {
        await repo.create({ values: incoming });
      }
      const row = await repo.findOne({});
      ctx.body = row?.toJSON?.() ?? null;
      await next();
    },
  };

  app.resourceManager.define({
    name: 'apiManagerSettings',
    actions: handlers,
  });
}
