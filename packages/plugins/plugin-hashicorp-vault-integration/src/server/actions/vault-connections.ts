import type { Context, Next } from '@nocobase/actions';
import type { Model, Repository } from '@nocobase/database';
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

    async listAllPaths(ctx: Context, next: Next) {
      const { path, maxDepth, maxEntries } = ctx.action.params as {
        path?: string;
        maxDepth?: number | string;
        maxEntries?: number | string;
      };
      try {
        const { client } = await getClient(plugin, ctx);
        const result = await client.listAllPaths(path || '', {
          maxDepth: maxDepth !== undefined ? Number(maxDepth) : undefined,
          maxEntries: maxEntries !== undefined ? Number(maxEntries) : undefined,
        });
        ctx.body = result;
      } catch (err) {
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async writeSecret(ctx: Context, next: Next) {
      const { path, key, value } = (ctx.action.params.values || ctx.action.params) as {
        path?: string;
        key?: string;
        value?: string;
      };
      if (!path) return ctx.throw(400, 'path is required');
      if (!key) return ctx.throw(400, 'key is required');
      if (typeof value !== 'string') return ctx.throw(400, 'value must be a string');
      try {
        const { connection, client } = await getClient(plugin, ctx);
        await client.setSecretKey(path, key, value);
        // drop stale cached values for mappings that read from this path
        const mappingRepo = ctx.db.getRepository('vaultSecretMappings') as Repository;
        const affected = (await mappingRepo.find({
          filter: { connectionId: connection.get('id'), secretPath: path },
        })) as Model[];
        for (const mapping of affected) {
          plugin.cache.invalidate(mapping.get('variableKey') as string);
        }
        ctx.body = { success: true };
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
