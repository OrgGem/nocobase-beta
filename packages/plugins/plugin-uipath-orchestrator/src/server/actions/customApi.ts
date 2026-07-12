/**
 * Custom API passthrough action
 *
 * Allows read-only calls to selected Orchestrator endpoints not covered by specific actions.
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext } from './shared';

const READ_ONLY_ENDPOINTS = [/^\/odata\/[A-Za-z0-9_.$%()/,'=-]+$/i, /^\/api\/Stats\/[A-Za-z0-9_.$%/()-]+$/i];

function isAllowedReadEndpoint(endpoint: string): boolean {
  if (endpoint.includes('..') || endpoint.includes('\\')) {
    return false;
  }

  return READ_ONLY_ENDPOINTS.some((pattern) => pattern.test(endpoint.split('?')[0]));
}

export function createCustomApiActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    proxy: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, method, endpoint, query } = ctx.action.params;
        const folder = extractFolderContext(ctx.action.params);

        if (!endpoint || typeof endpoint !== 'string') {
          ctx.status = 400;
          ctx.body = { errors: [{ message: 'endpoint is required' }] };
          await next();
          return;
        }

        const requestMethod = String(method || 'GET').toUpperCase();
        if (requestMethod !== 'GET') {
          ctx.status = 405;
          ctx.body = { errors: [{ message: 'Custom UiPath API proxy is read-only. Only GET is allowed.' }] };
          await next();
          return;
        }

        if (!isAllowedReadEndpoint(endpoint)) {
          ctx.status = 400;
          ctx.body = { errors: [{ message: 'Endpoint is not allowed by the read-only UiPath API proxy.' }] };
          await next();
          return;
        }

        const client = await plugin.getApiClient(instanceId);
        const result = await client.request(requestMethod, endpoint, { query, body: undefined, folder });

        await plugin.auditLog(ctx, {
          action: 'custom_api',
          resourceType: 'customApi',
          resourceId: endpoint,
          instanceId: Number(instanceId),
          folder,
          details: { method: requestMethod, endpoint },
        });

        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
