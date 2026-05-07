/**
 * Process / Release actions
 *
 * - list:     GET /odata/Releases
 * - get:      GET /odata/Releases({id})
 * - getArgs:  Fetch input arguments from release
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

export function createProcessActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);
        const data = await client.get('/odata/Releases', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    get: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get(`/odata/Releases(${filterByTk})`, { folder });
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    getArgs: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const release = await client.get(`/odata/Releases(${filterByTk})`, {
          query: { $select: 'InputArguments,Key,Name,ProcessKey' }, folder,
        });
        let args: any[] = [];
        if (release?.InputArguments) {
          try { args = JSON.parse(release.InputArguments); } catch {}
        }
        ctx.body = { release: { key: release.Key, name: release.Name }, inputArguments: args };
      } catch (error) { handleError(ctx, error); }
      await next();
    },
  };
}
