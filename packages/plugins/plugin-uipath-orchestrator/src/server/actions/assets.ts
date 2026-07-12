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
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    get: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get(`/odata/Assets(${filterByTk})`, { folder });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
