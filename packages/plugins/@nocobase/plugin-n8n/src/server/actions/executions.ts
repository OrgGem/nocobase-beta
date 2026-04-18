import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

export function createExecutionActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      const { instanceId, filter } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      const params: any = {};
      if (filter?.status) params.status = filter.status;
      if (filter?.workflowId) params.workflowId = filter.workflowId;
      if (filter?.limit) params.limit = filter.limit;
      if (filter?.cursor) params.cursor = filter.cursor;
      const result = await client.listExecutions(params);
      ctx.body = result;
      await next();
    },

    get: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.getExecution(filterByTk);
      await next();
    },

    retry: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.retryExecution(filterByTk);
      await next();
    },

    stop: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.stopExecution(filterByTk);
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      await client.deleteExecution(filterByTk);
      ctx.body = { success: true };
      await next();
    },
  };
}
