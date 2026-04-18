import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

export function createWorkflowActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      const { instanceId, filter } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      let data = await client.listAllWorkflows();
      if (filter?.search) {
        const q = filter.search.toLowerCase();
        data = data.filter((w: any) => w.name?.toLowerCase().includes(q));
      }
      ctx.body = { data };
      await next();
    },

    get: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.getWorkflow(filterByTk);
      await next();
    },

    activate: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.activateWorkflow(filterByTk);
      await next();
    },

    deactivate: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.deactivateWorkflow(filterByTk);
      await next();
    },

    create: async (ctx: Context, next: Next) => {
      const { instanceId, values } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.createWorkflow(values);
      await next();
    },

    update: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk, values } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.updateWorkflow(filterByTk, values);
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      await client.deleteWorkflow(filterByTk);
      ctx.body = { success: true };
      await next();
    },
  };
}
