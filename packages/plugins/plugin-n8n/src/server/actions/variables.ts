import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

function handleError(ctx: Context, error: any) {
  const message = error?.message || 'Unknown error';
  ctx.status = 400;
  ctx.body = { errors: [{ message }] };
}

export function createVariableActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.listVariables();
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    create: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.createVariable(values);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    update: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.updateVariable(filterByTk, values);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        await client.deleteVariable(filterByTk);
        ctx.body = { success: true };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
