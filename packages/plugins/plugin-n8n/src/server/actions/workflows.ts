import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

function handleError(ctx: Context, error: any) {
  const message = error?.message || 'Unknown error';
  ctx.status = 400;
  ctx.body = { errors: [{ message }] };
}

export function createWorkflowActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filter } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        let data = await client.listAllWorkflows();
        if (filter?.search) {
          const q = filter.search.toLowerCase();
          data = data.filter((w: any) => w.name?.toLowerCase().includes(q));
        }
        ctx.body = { data };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    get: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.getWorkflow(filterByTk);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    activate: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.activateWorkflow(filterByTk);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    deactivate: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.deactivateWorkflow(filterByTk);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    create: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.createWorkflow(values);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    update: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.updateWorkflow(filterByTk, values);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        await client.deleteWorkflow(filterByTk);
        ctx.body = { success: true };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
