import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

function handleError(ctx: Context, error: any) {
  const message = error?.message || 'Unknown error';
  ctx.status = 400;
  ctx.body = { errors: [{ message }] };
}

export function createExecutionActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filter } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const params: any = {};
        if (filter?.status) params.status = filter.status;
        if (filter?.workflowId) params.workflowId = filter.workflowId;
        if (filter?.limit) params.limit = filter.limit;
        if (filter?.cursor) params.cursor = filter.cursor;
        const result = await client.listExecutions(params);
        ctx.body = result;
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    get: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.getExecution(filterByTk);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    retry: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.retryExecution(filterByTk);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    stop: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.stopExecution(filterByTk);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        await client.deleteExecution(filterByTk);
        ctx.body = { success: true };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
