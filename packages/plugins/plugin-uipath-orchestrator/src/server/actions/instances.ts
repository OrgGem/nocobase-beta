/**
 * Instance actions
 *
 * CRUD is handled by NocoBase's built-in collection resource for uipathInstances.
 * This module adds the custom `testConnection` action.
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError } from './shared';

export function createInstanceActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    testConnection: async (ctx: Context, next: Next) => {
      try {
        const { filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(filterByTk);
        const result = await client.testConnection();
        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
