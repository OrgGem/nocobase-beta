/**
 * Custom API passthrough action
 *
 * Allows the client to call any Orchestrator endpoint not covered by specific actions.
 * Restricted to admin role via ACL.
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext } from './shared';

export function createCustomApiActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    proxy: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, method, endpoint, query, body } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        if (!endpoint || typeof endpoint !== 'string') {
          ctx.status = 400;
          ctx.body = { errors: [{ message: 'endpoint is required' }] };
          await next();
          return;
        }

        const result = await client.request(
          (method || 'GET').toUpperCase(),
          endpoint,
          { query, body, folder },
        );

        await plugin.auditLog(ctx, {
          action: 'custom_api',
          resourceType: 'customApi',
          resourceId: endpoint,
          instanceId: Number(instanceId),
          folder,
          details: { method: method || 'GET', endpoint },
        });

        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
