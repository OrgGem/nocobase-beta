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
      const start = Date.now();
      try {
        const { filterByTk } = ctx.action.params;
        if (!filterByTk) {
          ctx.body = { status: 'unhealthy', latencyMs: 0, message: 'Instance ID is required' };
          return next();
        }
        const client = await plugin.getApiClient(filterByTk);
        // Clear any cached token so we truly test the connection end-to-end
        client.clearToken();
        const result = await client.testConnection();
        ctx.body = result;
      } catch (error: any) {
        // Return a structured response instead of throwing (prevents ses_unhandled_rejection)
        ctx.body = {
          status: 'unhealthy',
          latencyMs: Date.now() - start,
          message: error?.message || 'Connection test failed with an unknown error',
        };
      }
      await next();
    },
  };
}
