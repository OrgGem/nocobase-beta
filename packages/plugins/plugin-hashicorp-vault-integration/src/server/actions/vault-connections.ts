import type { Context, Next } from '@nocobase/actions';
import type { Repository } from '@nocobase/database';
import { toSafeErrorMessage } from '../utils/redact';
import type PluginHashicorpVaultIntegrationServer from '../plugin';

async function getClient(plugin: PluginHashicorpVaultIntegrationServer, ctx: Context) {
  const { filterByTk } = ctx.action.params as { filterByTk?: number | string };
  if (!filterByTk) ctx.throw(400, 'filterByTk is required');
  const repo = ctx.db.getRepository('vaultConnections') as Repository;
  const connection = await repo.findOne({ filterByTk });
  if (!connection) ctx.throw(404, 'Connection not found');
  return { connection, client: await plugin.sync.buildClient(connection) };
}

export function createVaultConnectionActions(plugin: PluginHashicorpVaultIntegrationServer) {
  return {
    async testConnection(ctx: Context, next: Next) {
      const { filterByTk } = ctx.action.params as { filterByTk?: number | string };
      if (!filterByTk) {
        return ctx.throw(400, 'filterByTk is required');
      }
      const repo = ctx.db.getRepository('vaultConnections') as Repository;
      const connection = await repo.findOne({ filterByTk });
      if (!connection) {
        return ctx.throw(404, 'Connection not found');
      }
      try {
        const client = await plugin.sync.buildClient(connection);
        const health = await client.healthCheck();
        await client.verifyAuth();
        await connection.update({ lastCheckAt: new Date(), lastError: null }, { hooks: false });
        ctx.body = { success: true, version: health.version };
      } catch (err) {
        const message = toSafeErrorMessage(err);
        await connection.update({ lastCheckAt: new Date(), lastError: message }, { hooks: false });
        return ctx.throw(502, message);
      }
      return next();
    },

    async listPaths(ctx: Context, next: Next) {
      const { path } = ctx.action.params as { path?: string };
      try {
        const { client } = await getClient(plugin, ctx);
        ctx.body = { entries: await client.listPath(path || '') };
      } catch (err) {
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async listSecretKeys(ctx: Context, next: Next) {
      const { path } = ctx.action.params as { path?: string };
      if (!path) return ctx.throw(400, 'path is required');
      try {
        const { client } = await getClient(plugin, ctx);
        ctx.body = { keys: await client.listSecretKeys(path) };
      } catch (err) {
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },
  };
}
