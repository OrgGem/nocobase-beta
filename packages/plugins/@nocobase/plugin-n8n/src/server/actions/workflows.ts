export const workflows = {
  list: async (ctx, next) => {
    const { instanceId, filter } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    let data = await client.listAllWorkflows();
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      data = data.filter((w) => w.name?.toLowerCase().includes(q));
    }
    ctx.body = { data };
    await next();
  },

  get: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.getWorkflow(filterByTk);
    await next();
  },

  activate: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.activateWorkflow(filterByTk);
    await next();
  },

  deactivate: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.deactivateWorkflow(filterByTk);
    await next();
  },

  create: async (ctx, next) => {
    const { instanceId, values } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.createWorkflow(values);
    await next();
  },

  update: async (ctx, next) => {
    const { instanceId, filterByTk, values } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.updateWorkflow(filterByTk, values);
    await next();
  },

  destroy: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    await client.deleteWorkflow(filterByTk);
    ctx.body = { success: true };
    await next();
  },
};
