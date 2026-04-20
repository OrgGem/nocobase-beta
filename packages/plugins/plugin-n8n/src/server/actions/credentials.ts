import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';
// Static bundled credential types — /api/v1/credential-types does not exist in n8n API
// eslint-disable-next-line @typescript-eslint/no-require-imports
const credentialTypes = require('../data/credential-types.json');

function handleError(ctx: Context, error: any) {
  const message = error?.message || 'Unknown error';
  ctx.status = 400;
  ctx.body = { errors: [{ message }] };
}

export function createCredentialActions(plugin: PluginN8nServer) {
  return {
    list: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.listCredentials();
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    listTypes: async (ctx: Context, next: Next) => {
      // Static bundled data — /api/v1/credential-types does not exist in n8n API
      ctx.body = credentialTypes;
      await next();
    },

    schema: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.getCredentialSchema(filterByTk);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    create: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.createCredential(values);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    update: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk, values } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.updateCredential(filterByTk, values);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    destroy: async (ctx: Context, next: Next) => {
      try {
        const { instanceId, filterByTk } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        await client.deleteCredential(filterByTk);
        ctx.body = { success: true };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
