/**
 * Asset actions — GET/POST/PUT/DELETE /odata/Assets
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

export function createAssetActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);
        const data = await client.get('/odata/Assets', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    get: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get(`/odata/Assets(${filterByTk})`, { folder });
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    create: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const result = await client.post('/odata/Assets', values, { folder });
        await plugin.auditLog(ctx, {
          action: 'create_asset', resourceType: 'asset',
          resourceId: values.Name, instanceId: Number(instanceId), folder,
        });
        ctx.body = result;
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    update: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const result = await client.put(`/odata/Assets(${filterByTk})`, values, { folder });
        await plugin.auditLog(ctx, {
          action: 'update_asset', resourceType: 'asset',
          resourceId: String(filterByTk), instanceId: Number(instanceId), folder,
        });
        ctx.body = result;
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        await client.delete(`/odata/Assets(${filterByTk})`, { folder });
        await plugin.auditLog(ctx, {
          action: 'delete_asset', resourceType: 'asset',
          resourceId: String(filterByTk), instanceId: Number(instanceId), folder,
        });
        ctx.body = { success: true };
      } catch (error) { handleError(ctx, error); }
      await next();
    },
  };
}
