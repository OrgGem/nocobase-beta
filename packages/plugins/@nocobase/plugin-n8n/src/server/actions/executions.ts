export const executions = {
  list: async (ctx, next) => {
    const { instanceId, filter } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    const params: any = {};
    if (filter?.status) params.status = filter.status;
    if (filter?.workflowId) params.workflowId = filter.workflowId;
    if (filter?.limit) params.limit = filter.limit;
    if (filter?.cursor) params.cursor = filter.cursor;
    const result = await client.listExecutions(params);
    ctx.body = result;
    await next();
  },

  get: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.getExecution(filterByTk);
    await next();
  },

  retry: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.retryExecution(filterByTk);
    await next();
  },

  stop: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.stopExecution(filterByTk);
    await next();
  },

  destroy: async (ctx, next) => {
    const { instanceId, filterByTk } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    await client.deleteExecution(filterByTk);
    ctx.body = { success: true };
    await next();
  },
};
