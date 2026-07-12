import type { Context, Next } from '@nocobase/actions';
import type { Model, Repository } from '@nocobase/database';
import { toSafeErrorMessage } from '../utils/redact';
import type PluginHashicorpVaultIntegrationServer from '../plugin';

export function createVaultActions(plugin: PluginHashicorpVaultIntegrationServer) {
  return {
    async resolve(ctx: Context, next: Next) {
      const { variableKey } = ctx.action.params as { variableKey?: string };
      const repo = ctx.db.getRepository('vaultSecretMappings') as Repository;

      if (variableKey) {
        const mapping = await repo.findOne({
          filter: { variableKey, exposeToClient: true },
          appends: ['connection'],
        });
        if (!mapping) {
          return ctx.throw(404, 'Variable not found');
        }
        let value = plugin.cache.get(variableKey);
        if (value === undefined) {
          try {
            value = await plugin.sync.resolveMapping(mapping);
          } catch (err) {
            return ctx.throw(502, toSafeErrorMessage(err));
          }
        }
        ctx.body = { value };
        return next();
      }

      const mappings = (await repo.find({
        filter: { exposeToClient: true },
        appends: ['connection'],
      })) as Model[];
      const values: Record<string, string> = {};
      for (const mapping of mappings) {
        const key = mapping.get('variableKey') as string;
        let value = plugin.cache.get(key);
        if (value === undefined) {
          try {
            value = await plugin.sync.resolveMapping(mapping);
          } catch {
            continue;
          }
        }
        values[key] = value;
      }
      ctx.body = { values };
      return next();
    },

    async listKeys(ctx: Context, next: Next) {
      const repo = ctx.db.getRepository('vaultSecretMappings') as Repository;
      const mappings = (await repo.find({
        filter: { exposeToClient: true },
        fields: ['variableKey'],
        sort: ['variableKey'],
      })) as Model[];
      ctx.body = mappings.map((m) => ({ variableKey: m.get('variableKey') as string }));
      return next();
    },

    async syncNow(ctx: Context, next: Next) {
      await plugin.sync.tick();
      ctx.body = { success: true };
      return next();
    },
  };
}
