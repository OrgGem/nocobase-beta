/**
 * Trigger actions
 *
 * UiPath exposes time and queue triggers through /odata/ProcessSchedules.
 * This plugin keeps the action read-only for monitoring process registration.
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { extractFolderContext, extractODataFilter, handleError } from './shared';

export function createTriggerActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    processSchedules: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);

        if (!query.$orderby) {
          query.$orderby = 'Name asc';
        }

        const data = await client.get('/odata/ProcessSchedules', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
