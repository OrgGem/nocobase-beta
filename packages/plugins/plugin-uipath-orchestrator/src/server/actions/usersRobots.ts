/**
 * Users & Robots actions
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext, extractODataFilter } from './shared';

export function createUsersActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);
        const data = await client.get('/odata/Users', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) { handleError(ctx, error); }
      await next();
    },
  };
}

export function createRobotActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);
        const data = await client.get('/odata/Robots', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) { handleError(ctx, error); }
      await next();
    },
  };
}

export function createMachineActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);
        const data = await client.get('/odata/Machines', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) { handleError(ctx, error); }
      await next();
    },
  };
}

export function createSessionActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        const query = extractODataFilter(ctx.action.params);
        const data = await client.get('/odata/Sessions', { query, folder });
        ctx.body = { data: data.value || data, count: data['@odata.count'] };
      } catch (error) { handleError(ctx, error); }
      await next();
    },
  };
}
