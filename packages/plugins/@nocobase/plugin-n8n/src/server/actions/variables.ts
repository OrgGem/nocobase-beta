export const variables = {
  list: async (ctx, next) => {
    const { instanceId } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.listVariables();
    await next();
  },

  create: async (ctx, next) => {
    const { instanceId, values } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.createVariable(values);
    await next();
  },

  update: async (ctx, next) => {
    const { instanceId, filterByTk, values } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.updateVariable(filterByTk, values);
    await next();
  },

  destroy: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    await client.deleteVariable(filterByTk);
    ctx.body = { success: true };
    await next();
  },
};
