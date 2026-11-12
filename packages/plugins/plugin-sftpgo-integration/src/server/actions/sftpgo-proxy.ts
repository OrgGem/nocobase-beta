// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from '@nocobase/actions';
import type { Model } from '@nocobase/database';
import { SftpgoInvalidApiKeyScopeError, type SftpgoResourceType } from '../sftpgo-client';
import { toSafeErrorMessage } from '../utils/redact';
import type PluginSftpgoIntegrationServer from '../plugin';
import { SftpgoEnvironmentPermissionError } from '../utils/environment-permission';
import { loadAuthorizedConnection } from '../utils/load-authorized-connection';

async function loadConnection(ctx: Context, type: SftpgoResourceType): Promise<Model> {
  const { connectionId } = ctx.action.params as { connectionId?: number | string };
  if (!connectionId) {
    return ctx.throw(400, 'connectionId is required');
  }
  const connection = await loadAuthorizedConnection(ctx, connectionId);
  if (!connection.get('enabled')) {
    return ctx.throw(400, 'Connection is disabled');
  }
  if (type === 'apikeys' && connection.get('authMethod') === 'apikey') {
    return ctx.throw(
      400,
      ctx.t('API key management requires an admin-authenticated connection', { ns: 'plugin-sftpgo-integration' }),
    );
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
      const connection = await loadConnection(ctx, type);
      const { limit, offset } = ctx.action.params as { limit?: number; offset?: number };
      try {
        const client = await plugin.getClient(connection, ctx);
        const resources = await client.listResources(type, { limit, offset });
        ctx.body =
          type === 'apikeys'
            ? await plugin.attachMaskedApiKeySecrets(connection.get('id') as number, resources)
            : resources;
      } catch (err) {
        if (err instanceof SftpgoEnvironmentPermissionError) throw err;
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async get(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, type);
      const { filterByTk } = ctx.action.params as { filterByTk?: string | number };
      if (!filterByTk) return ctx.throw(400, 'filterByTk is required');
      try {
        const client = await plugin.getClient(connection, ctx);
        ctx.body = await client.getResource(type, filterByTk);
      } catch (err) {
        if (err instanceof SftpgoEnvironmentPermissionError) throw err;
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async create(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, type);
      const values = (ctx.action.params.values || {}) as Record<string, unknown>;
      try {
        const client = await plugin.getClient(connection, ctx);
        const created = await client.createResource(type, values);
        if (type === 'apikeys' && typeof created.key === 'string') {
          let keyStorageWarning = true;
          if (typeof created.id === 'string' && created.id && typeof values.name === 'string') {
            try {
              await plugin.saveApiKeySecret(connection.get('id') as number, created.id, values.name, created.key);
              keyStorageWarning = false;
            } catch {
              // The upstream key already exists and its secret is shown only once.
            }
          }
          ctx.body = keyStorageWarning ? { ...created, keyStorageWarning } : created;
        } else {
          ctx.body = created;
        }
      } catch (err) {
        if (err instanceof SftpgoEnvironmentPermissionError) throw err;
        if (err instanceof SftpgoInvalidApiKeyScopeError) {
          return ctx.throw(400, ctx.t('Invalid API key scope', { ns: 'plugin-sftpgo-integration' }));
        }
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async update(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, type);
      const { filterByTk, values } = ctx.action.params as {
        filterByTk?: string | number;
        values?: Record<string, unknown>;
      };
      if (!filterByTk) return ctx.throw(400, 'filterByTk is required');
      try {
        const client = await plugin.getClient(connection, ctx);
        ctx.body = await client.updateResource(type, filterByTk, values || {});
      } catch (err) {
        if (err instanceof SftpgoEnvironmentPermissionError) throw err;
        if (err instanceof SftpgoInvalidApiKeyScopeError) {
          return ctx.throw(400, ctx.t('Invalid API key scope', { ns: 'plugin-sftpgo-integration' }));
        }
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },

    async destroy(ctx: Context, next: Next) {
      const connection = await loadConnection(ctx, type);
      const { filterByTk } = ctx.action.params as { filterByTk?: string | number };
      if (!filterByTk) return ctx.throw(400, 'filterByTk is required');
      try {
        const client = await plugin.getClient(connection, ctx);
        await client.deleteResource(type, filterByTk);
        if (type === 'apikeys') {
          await plugin.deleteApiKeySecret(connection.get('id') as number, String(filterByTk));
        }
        ctx.body = true;
      } catch (err) {
        if (err instanceof SftpgoEnvironmentPermissionError) throw err;
        return ctx.throw(502, toSafeErrorMessage(err));
      }
      return next();
    },
  };
}
