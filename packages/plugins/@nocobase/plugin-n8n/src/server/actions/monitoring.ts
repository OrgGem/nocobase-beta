import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

export function createMonitoringActions(plugin: PluginN8nServer) {
  return {
    health: async (ctx: Context, next: Next) => {
      const { instanceId } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.healthCheck();
      await next();
    },

    metrics: async (ctx: Context, next: Next) => {
      const { instanceId } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.getMetricsSnapshot();
      await next();
    },

    metricsHistory: async (ctx: Context, next: Next) => {
      const { instanceId } = ctx.action.params;
      const resolvedId = instanceId ? Number(instanceId) : await plugin.getDefaultInstanceId();
      ctx.body = { data: plugin.metricsHistory.get(resolvedId) || [] };
      await next();
    },

    workers: async (ctx: Context, next: Next) => {
      const { instanceId } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);
      ctx.body = await client.getWorkers();
      await next();
    },

    dashboard: async (ctx: Context, next: Next) => {
      const { instanceId } = ctx.action.params;
      const client = await plugin.getApiClient(instanceId);

      const [health, workflowsData, executionsData] = await Promise.all([
        client.healthCheck(),
        client.listAllWorkflows(),
        client.listExecutions({ limit: 50 }),
      ]);

      const workflows = workflowsData || [];
      const executions = executionsData?.data || [];
      const successCount = executions.filter((e: any) => e.status === 'success').length;
      const errorCount = executions.filter((e: any) => e.status === 'error').length;
      const runningCount = executions.filter((e: any) => e.status === 'running').length;

      ctx.body = {
        health,
        workflows: {
          total: workflows.length,
          active: workflows.filter((w: any) => w.active).length,
        },
        executions: {
          total: executions.length,
          success: successCount,
          error: errorCount,
          running: runningCount,
          successRate: executions.length > 0 ? Math.round((successCount / executions.length) * 100) : 0,
        },
        recentFailures: executions.filter((e: any) => e.status === 'error').slice(0, 10),
      };
      await next();
    },
  };
}
