export const credentials = {
  list: async (ctx, next) => {
    const { instanceId } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.listCredentials();
    await next();
  },

  listTypes: async (ctx, next) => {
    const { instanceId } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.getCredentialTypes();
    await next();
  },

  create: async (ctx, next) => {
    const { instanceId, values } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.createCredential(values);
    await next();
  },

  update: async (ctx, next) => {
    const { instanceId, filterByTk, values } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.updateCredential(filterByTk, values);
    await next();
  },

  destroy: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    await client.deleteCredential(filterByTk);
    ctx.body = { success: true };
    await next();
  },
};
