/**
 * Stats actions — dashboard KPIs from UiPath Stats API
 */

import type { Context, Next } from '@nocobase/actions';
import type { PluginUiPathOrchestratorServer } from '../plugin';
import { handleError, extractFolderContext } from './shared';

export function createStatsActions(plugin: PluginUiPathOrchestratorServer) {
  return {
    /** Aggregated dashboard snapshot */
    dashboard: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);

        const [jobsStats, sessionsStats, countStats, licenseStats] = await Promise.all([
          client.get('/api/Stats/GetJobsStats', { folder }).catch(() => null),
          client.get('/api/Stats/GetSessionsStats', { folder }).catch(() => null),
          client.get('/api/Stats/GetCountStats', { folder }).catch(() => null),
          client.get('/api/Stats/GetLicenseStats', { folder }).catch(() => null),
        ]);

        // Recent faulted jobs
        const faultedJobs = await client.get('/odata/Jobs', {
          query: {
            $filter: "State eq 'Faulted'",
            $top: 10,
            $orderby: 'CreationTime desc',
          },
          folder,
        }).catch(() => ({ value: [] }));

        // Error logs count last 24h
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const errorLogCount = await client.get('/odata/RobotLogs/$count', {
          query: { $filter: `Level eq 'Error' and TimeStamp gt ${yesterday}` },
          folder,
        }).catch(() => 0);

        ctx.body = {
          timestamp: Date.now(),
          jobsStats,
          sessionsStats,
          countStats,
          licenseStats,
          recentFaultedJobs: faultedJobs.value || [],
          errorLogs24h: typeof errorLogCount === 'number' ? errorLogCount : Number(errorLogCount) || 0,
        };
      } catch (error) {
        handleError(ctx, error);
      }
      await next();
    },

    jobsStats: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get('/api/Stats/GetJobsStats', { folder });
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    sessionsStats: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get('/api/Stats/GetSessionsStats', { folder });
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    countStats: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get('/api/Stats/GetCountStats', { folder });
      } catch (error) { handleError(ctx, error); }
      await next();
    },

    licenseStats: async (ctx: Context, next: Next) => {
      try {
        const { instanceId } = ctx.action.params;
        const client = await plugin.getApiClient(instanceId);
        const folder = extractFolderContext(ctx.action.params);
        ctx.body = await client.get('/api/Stats/GetLicenseStats', { folder });
      } catch (error) { handleError(ctx, error); }
      await next();
    },
  };
}
