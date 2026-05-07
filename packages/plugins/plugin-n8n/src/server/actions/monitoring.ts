import type { Context, Next } from '@nocobase/actions';
import type { PluginN8nServer } from '../plugin';

function handleError(ctx: Context, error: any) {
  const message = error?.message || 'Unknown error';
  ctx.status = 400;
  ctx.body = { errors: [{ message }] };
}

export function createMonitoringActions(plugin: PluginN8nServer) {
  return {
    health: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.healthCheck();
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    metrics: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        ctx.body = await client.getMetricsSnapshot();
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    metricsHistory: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const resolvedId = instanceId ? Number(instanceId) : await plugin.getDefaultInstanceId();
        
        const cacheKey = `n8n-metrics:history:${resolvedId}`;
        let data = await plugin.app.cache.get(cacheKey);
        
        if (!data || !Array.isArray(data)) {
          data = plugin.metricsHistory.get(resolvedId) || [];
        }
        
        ctx.body = { data };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    workers: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const resolvedId = instanceId ? Number(instanceId) : await plugin.getDefaultInstanceId();
        const instance = await plugin.db.getRepository('n8nInstances').findOne({
          filter: { id: resolvedId },
        });

        const workers = Array.isArray(instance?.workers) ? instance.workers : [];

        if (workers.length === 0) {
          ctx.body = [];
          await next();
          return;
        }

        const results = await Promise.all(
          workers.map(async (w: any) => {
            const url = w.url?.replace(/\/+$/, '') || '';
            if (!url) return null;
            
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 5000);
              const headers: Record<string, string> = { 'Accept': 'application/json' };
              // We ping healthz since workers don't have the normal API auth
              const res = await fetch(`${url}/healthz`, {
                method: 'GET',
                headers,
                signal: controller.signal,
              });
              clearTimeout(timer);
              
              return {
                workerId: w.hostname,
                hostname: w.hostname,
                status: res.ok ? 'online' : 'error',
                runningJobsSummary: [],
                lastSeen: new Date().toISOString(),
              };
            } catch (err) {
              return {
                workerId: w.hostname,
                hostname: w.hostname,
                status: 'offline',
                runningJobsSummary: [],
                lastSeen: null,
              };
            }
          })
        );
        
        ctx.body = results.filter(Boolean);
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    dashboard: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);

        const [health, workflowsData, executionsData] = await Promise.all([
          client.healthCheck(),
          client.listAllWorkflows(),
          client.listExecutions({ limit: 250 }),
        ]);

        const workflows = workflowsData || [];
        const executions = executionsData?.data || [];
        const successCount = executions.filter((e: any) => e.status === 'success').length;
        const errorCount = executions.filter((e: any) => e.status === 'error').length;
        const runningCount = executions.filter((e: any) => e.status === 'running').length;
        const waitingCount = executions.filter((e: any) => e.status === 'waiting').length;

        // Build 24h execution history grouped by hour
        const now = Date.now();
        const hours24ago = now - 24 * 60 * 60 * 1000;
        const hourlyHistory: Array<{ hour: string; success: number; error: number; running: number }> = [];
        for (let i = 23; i >= 0; i--) {
          const hourStart = new Date(now - i * 60 * 60 * 1000);
          hourStart.setMinutes(0, 0, 0);
          const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
          const hourLabel = `${hourStart.getHours().toString().padStart(2, '0')}:00`;

          const inHour = executions.filter((e: any) => {
            const t = new Date(e.startedAt).getTime();
            return t >= hourStart.getTime() && t < hourEnd.getTime();
          });

          hourlyHistory.push({
            hour: hourLabel,
            success: inHour.filter((e: any) => e.status === 'success').length,
            error: inHour.filter((e: any) => e.status === 'error').length,
            running: inHour.filter((e: any) => e.status === 'running' || e.status === 'waiting').length,
          });
        }

        // Average duration (completed executions)
        const completed = executions.filter((e: any) => e.startedAt && e.stoppedAt);
        const avgDuration = completed.length > 0
          ? Math.round(completed.reduce((sum: number, e: any) =>
              sum + (new Date(e.stoppedAt).getTime() - new Date(e.startedAt).getTime()), 0) / completed.length)
          : 0;

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
            waiting: waitingCount,
            successRate: executions.length > 0 ? Math.round((successCount / executions.length) * 100) : 0,
            avgDuration,
          },
          hourlyHistory,
          recentFailures: executions.filter((e: any) => e.status === 'error').slice(0, 10),
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },
  };
}
