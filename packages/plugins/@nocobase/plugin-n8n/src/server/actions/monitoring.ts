export const monitoring = {
  health: async (ctx, next) => {
    const { instanceId } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.healthCheck();
    await next();
  },

  metrics: async (ctx, next) => {
    const { instanceId } = ctx.action.params;
    const plugin = ctx.app.pm.get('plugin-n8n');
    const client = await plugin.getApiClient(instanceId);
    ctx.body = await client.getMetricsSnapshot();
    await next();
  },

  metricsHistory: async (ctx, next) => {
    const { instanceId } = ctx.action.params;
    const plugin = ctx.app.pm.get('plugin-n8n');
    const resolvedId = instanceId ? Number(instanceId) : await plugin.getDefaultInstanceId();
    ctx.body = { data: plugin.metricsHistory.get(resolvedId) || [] };
    await next();
  },

  workers: async (ctx, next) => {
    const { instanceId } = ctx.action.params;
    const client = await ctx.app.pm.get('plugin-n8n').getApiClient(instanceId);
    ctx.body = await client.getWorkers();
    await next();
  },

  dashboard: async (ctx, next) => {
    const { instanceId } = ctx.action.params;
    const plugin = ctx.app.pm.get('plugin-n8n');
    const client = await plugin.getApiClient(instanceId);

    const [health, workflowsData, executionsData] = await Promise.all([
      client.healthCheck(),
      client.listAllWorkflows(),
      client.listExecutions({ limit: 50 }),
    ]);

    const workflows = workflowsData || [];
    const executions = executionsData?.data || [];
    const successCount = executions.filter((e) => e.status === 'success').length;
    const errorCount = executions.filter((e) => e.status === 'error').length;
    const runningCount = executions.filter((e) => e.status === 'running').length;

    ctx.body = {
      health,
      workflows: {
        total: workflows.length,
        active: workflows.filter((w) => w.active).length,
      },
      executions: {
        total: executions.length,
        success: successCount,
        error: errorCount,
        running: runningCount,
        successRate: executions.length > 0 ? Math.round((successCount / executions.length) * 100) : 0,
      },
      recentFailures: executions.filter((e) => e.status === 'error').slice(0, 10),
    };
    await next();
  },
};
