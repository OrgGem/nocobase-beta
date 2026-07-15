import type { Context, Next } from '@nocobase/actions';
import type { Model, Repository } from '@nocobase/database';
import type { SftpgoResourceType } from '../sftpgo-client';
import { toSafeErrorMessage } from '../utils/redact';
import type PluginSftpgoIntegrationServer from '../plugin';

async function loadConnection(ctx: Context, plugin: PluginSftpgoIntegrationServer): Promise<Model> {
  const { connectionId } = ctx.action.params as { connectionId?: number | string };
  if (!connectionId) {
    return ctx.throw(400, 'connectionId is required');
  }
  const repo = ctx.db.getRepository('sftpgoConnections') as Repository;
  const connection = await repo.findOne({ filterByTk: connectionId });
  if (!connection) {
    return ctx.throw(404, 'Connection not found');
  }
  if (!connection.get('enabled')) {
    return ctx.throw(400, 'Connection is disabled');
  }
  return connection;
}

/**
 * Proxies list/get/create/update/destroy for a single SFTPGo resource type
 * (users, folders, apikeys) against the SFTPGo REST API of the connection
 * given by `connectionId`. Nothing is persisted locally — every call is live.
 */
export function createSftpgoProxyActions(plugin: PluginSftpgoIntegrationServer, type: SftpgoResourceType) {
  return {
    async list(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, plugin);
      const { limit, offset } = ctx.action.params as { limit?: number; offset?: number };
      try {
        const client = await plugin.getClient(connection);
        const resources = await client.listResources(type, { limit, offset });
        ctx.body =
          type === 'apikeys'
            ? await plugin.attachMaskedApiKeySecrets(connection.get('id') as number, resources)
            : resources;
      } catch (err) {
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async get(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, plugin);
      const { filterByTk } = ctx.action.params as { filterByTk?: string | number };
      if (!filterByTk) return ctx.throw(400, 'filterByTk is required');
      try {
        const client = await plugin.getClient(connection);
        ctx.body = await client.getResource(type, filterByTk);
      } catch (err) {
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async create(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, plugin);
      const values = (ctx.action.params.values || {}) as Record<string, unknown>;
      try {
        const client = await plugin.getClient(connection);
        const created = await client.createResource(type, values);
        if (type === 'apikeys' && typeof created.key === 'string' && typeof values.name === 'string') {
          const apiKeys = await client.listResources('apikeys', { limit: 500 });
          const match = apiKeys.find(
            (item) => !!item && typeof item === 'object' && (item as Record<string, unknown>).name === values.name,
          ) as Record<string, unknown> | undefined;
          if (!match?.id) {
            return ctx.throw(502, 'API key was created but its identifier could not be resolved');
          }
          await plugin.saveApiKeySecret(connection.get('id') as number, String(match.id), values.name, created.key);
        }
        ctx.body = created;
      } catch (err) {
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async update(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, plugin);
      const { filterByTk, values } = ctx.action.params as {
        filterByTk?: string | number;
        values?: Record<string, unknown>;
      };
      if (!filterByTk) return ctx.throw(400, 'filterByTk is required');
      try {
        const client = await plugin.getClient(connection);
        ctx.body = await client.updateResource(type, filterByTk, values || {});
      } catch (err) {
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async destroy(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, plugin);
      const { filterByTk } = ctx.action.params as { filterByTk?: string | number };
      if (!filterByTk) return ctx.throw(400, 'filterByTk is required');
      try {
        const client = await plugin.getClient(connection);
        await client.deleteResource(type, filterByTk);
        if (type === 'apikeys') {
          await plugin.deleteApiKeySecret(connection.get('id') as number, String(filterByTk));
        }
        ctx.body = true;
      } catch (err) {
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },
  };
}
