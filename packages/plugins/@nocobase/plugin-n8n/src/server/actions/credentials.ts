import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

export function createCredentialActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      const { instanceId } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.listCredentials();
      await next();
    },

    listTypes: async (ctx: Context, next: Next) => {
      const { instanceId } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.getCredentialTypes();
      await next();
    },

    create: async (ctx: Context, next: Next) => {
      const { instanceId, values } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.createCredential(values);
      await next();
    },

    update: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk, values } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.updateCredential(filterByTk, values);
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      const { instanceId, filterByTk } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      await client.deleteCredential(filterByTk);
      ctx.body = { success: true };
      await next();
    },
  };
}
