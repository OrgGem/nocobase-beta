/**
 * Process / Release actions
 *
 * - list:     GET /odata/Releases
 * - get:      GET /odata/Releases({id})
 * - getArgs:  Fetch input arguments from the release's process definition
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

function parseArgumentJson(value: unknown): unknown {
  if (typeof value !== 'string' || !value) {
    return value ?? {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

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
        ctx.body = await client.get(`/odata/Releases(${filterByTk})`, { folder });
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    getArgs: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const release = await client.get(`/odata/Releases(${filterByTk})`, {
          query: { $select: 'Key,Name,ProcessKey' },
          folder,
        });
        const processKey = String(release?.ProcessKey || release?.Key || '');

        if (!processKey) {
          throw new Error('Process key is required to load input arguments');
        }

        const args = await client.get(
          `/odata/Processes/UiPath.Server.Configuration.OData.GetArguments(key='${encodeURIComponent(
            escapeODataString(processKey),
          )}')`,
          { folder },
        );

        ctx.body = {
          release: { key: release.Key, name: release.Name, processKey },
          inputArguments: parseArgumentJson(args?.Input),
          outputArguments: parseArgumentJson(args?.Output),
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
