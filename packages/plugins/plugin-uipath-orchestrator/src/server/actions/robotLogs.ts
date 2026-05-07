/**
 * Robot Logs actions
 *
 * - list:  GET /odata/RobotLogs
 * - count: GET /odata/RobotLogs/$count (with $filter)
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

export function createRobotLogActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);

        // Default: newest first
        if (!query.$orderby) query.$orderby = 'TimeStamp desc';

        const data = await client.get('/odata/RobotLogs', { query, folder });
        ctx.body = {
          data: data.value || data,
          count: data['@odata.count'],
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    count: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        // Build filter for count — e.g., errors in last 24h
        const { filter: odataFilter } = ctx.action.params;
        const query: Record<string, any> = {};
        if (odataFilter) query.$filter = odataFilter;

        const data = await client.get('/odata/RobotLogs/$count', { query, folder });
        ctx.body = { count: typeof data === 'number' ? data : Number(data) || 0 };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
