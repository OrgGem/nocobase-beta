/**
 * Job actions
 *
 * - list:    GET /odata/Jobs
 * - get:     GET /odata/Jobs({id})
 * Read-only monitoring actions only.
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

export function createJobActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);

        // Default: most recent first
        if (!query.$orderby) query.$orderby = 'CreationTime desc';

        const data = await client.get('/odata/Jobs', { query, folder });
        ctx.body = {
          data: data.value || data,
          count: data['@odata.count'],
        };
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
        ctx.body = await client.get(`/odata/Jobs(${filterByTk})`, { folder });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
