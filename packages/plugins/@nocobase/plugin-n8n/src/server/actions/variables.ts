import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

export function createVariableActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      const { instanceId } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.listVariables();
      await next();
    },

    create: async (ctx: Context, next: Next) => {
      const { instanceId, values } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.createVariable(values);
      await next();
    },

    update: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk, values } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.updateVariable(filterByTk, values);
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      await client.deleteVariable(filterByTk);
      ctx.body = { success: true };
      await next();
    },
  };
}
